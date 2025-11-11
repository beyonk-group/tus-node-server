import stream from 'node:stream'
import type http from 'node:http'
import debug from 'debug'
import {ReadableStream} from 'node:stream/web'

import {ERRORS, TUS_RESUMABLE, Upload, DataStore} from '@tus/utils'
import * as BunnyStorageSDK from '@bunny.net/storage-sdk'

const log = debug('tus-node-server:stores:bunnystore')

export type Options = {
  /**
   * The storage zone instance created using `BunnyStorageSDK.zone.connect_with_accesskey()`
   */
  storageZone: BunnyStorageSDK.zone.StorageZone
}

type MetadataValue = {
  file: Upload
  'tus-version': string
}

/**
 * Convert a Node.js Readable stream to a Web ReadableStream
 */
function nodeStreamToWebStream(nodeStream: stream.Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | Uint8Array) => {
        const uint8Array = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        controller.enqueue(uint8Array)
      })
      nodeStream.on('end', () => {
        controller.close()
      })
      nodeStream.on('error', (err) => {
        controller.error(err)
      })
    },
    cancel() {
      nodeStream.destroy()
    },
  })
}

/**
 * Convert a Web ReadableStream to a Node.js Readable stream
 */
function webStreamToNodeStream(webStream: ReadableStream<Uint8Array>): stream.Readable {
  const reader = webStream.getReader()
  const nodeStream = new stream.Readable({
    async read() {
      try {
        const {done, value} = await reader.read()
        if (done) {
          this.push(null)
        } else {
          this.push(Buffer.from(value))
        }
      } catch (error) {
        this.destroy(error as Error)
      }
    },
  })

  return nodeStream
}

export class BunnyStore extends DataStore {
  public storageZone: BunnyStorageSDK.zone.StorageZone

  constructor(options: Options) {
    super()

    if (!options.storageZone) {
      throw new Error('BunnyStore must have a storageZone')
    }

    this.storageZone = options.storageZone

    this.extensions = ['creation', 'creation-with-upload', 'creation-defer-length']
  }

  /**
   * Get the path for the metadata info file
   */
  #infoKey(id: string): string {
    return `${id}.info`
  }

  /**
   * Save upload metadata to a `${file_id}.info` file
   */
  async #saveMetadata(upload: Upload): Promise<void> {
    log(`[${upload.id}] saving metadata`)
    const metadata: MetadataValue = {
      file: upload,
      'tus-version': TUS_RESUMABLE,
    }

    const metadataJson = JSON.stringify(metadata)
    const metadataStream = new stream.Readable({
      read() {
        this.push(Buffer.from(metadataJson))
        this.push(null)
      },
    })

    await BunnyStorageSDK.file.upload(
      this.storageZone,
      this.#infoKey(upload.id),
      nodeStreamToWebStream(metadataStream)
    )
    log(`[${upload.id}] metadata file saved`)
  }

  /**
   * Retrieve upload metadata from `${file_id}.info`
   */
  async #getMetadata(id: string): Promise<MetadataValue> {
    try {
      const infoFile = await BunnyStorageSDK.file.get(this.storageZone, this.#infoKey(id))
      const {stream: webStream} = await infoFile.data()
      const nodeStream = webStreamToNodeStream(webStream)

      const chunks: Buffer[] = []
      for await (const chunk of nodeStream) {
        chunks.push(chunk)
      }

      const metadataJson = Buffer.concat(chunks).toString('utf-8')
      const metadata: MetadataValue = JSON.parse(metadataJson)

      // Reconstruct Upload object
      metadata.file = new Upload({
        id: metadata.file.id,
        size: metadata.file.size,
        offset: metadata.file.offset,
        metadata: metadata.file.metadata,
        storage: metadata.file.storage,
        creation_date: metadata.file.creation_date,
      })

      return metadata
    } catch (error) {
      log('[BunnyStore] getMetadata error', error)
      throw ERRORS.FILE_NOT_FOUND
    }
  }

  /**
   * Convert the Upload object to a format that can be stored in metadata
   */
  #stringifyUploadKeys(upload: Upload) {
    return {
      size: upload.size ?? null,
      sizeIsDeferred: `${upload.sizeIsDeferred}`,
      offset: upload.offset,
      metadata: JSON.stringify(upload.metadata),
      storage: JSON.stringify(upload.storage),
    }
  }

  async create(upload: Upload): Promise<Upload> {
    log(`[${upload.id}] creating upload`)
    if (!upload.id) {
      throw ERRORS.FILE_NOT_FOUND
    }

    upload.storage = {
      type: 'bunny',
      path: upload.id,
      bucket: BunnyStorageSDK.zone.name(this.storageZone),
    }

    upload.creation_date = new Date().toISOString()

    // Create an empty file to initialize the upload
    const emptyStream = new stream.Readable({
      read() {
        this.push(null)
      },
    })

    const uploadOptions: BunnyStorageSDK.file.UploadOptions = {}
    if (upload.metadata?.contentType) {
      uploadOptions.contentType = upload.metadata.contentType
    }

    try {
      await BunnyStorageSDK.file.upload(
        this.storageZone,
        upload.id,
        nodeStreamToWebStream(emptyStream),
        uploadOptions
      )

      await this.#saveMetadata(upload)

      log(`[${upload.id}] upload created`)
      return upload
    } catch (error) {
      log('[BunnyStore] create error', error)
      throw ERRORS.FILE_WRITE_ERROR
    }
  }

  async read(file_id: string): Promise<stream.Readable> {
    try {
      const {stream: webStream} = await BunnyStorageSDK.file.download(
        this.storageZone,
        file_id
      )
      return webStreamToNodeStream(webStream)
    } catch (error) {
      log('[BunnyStore] read error', error)
      throw ERRORS.FILE_NOT_FOUND
    }
  }

  /**
   * Write data to the file, handling resumable uploads by combining existing data with new data
   */
  async write(
    readable: http.IncomingMessage | stream.Readable,
    id: string,
    offset: number
  ): Promise<number> {
    if (readable.destroyed) {
      throw ERRORS.FILE_WRITE_ERROR
    }

    const upload = await this.getUpload(id)

    if (offset !== upload.offset) {
      log(`[${id}] offset mismatch: requested ${offset}, actual ${upload.offset}`)
      throw ERRORS.INVALID_OFFSET
    }

    return new Promise(async (resolve, reject) => {
      // Check if stream is destroyed after async operations
      if (readable.destroyed) {
        return reject(ERRORS.FILE_WRITE_ERROR)
      }

      let isResolved = false
      let hasEnded = false

      try {
        let bytesReceived = 0
        const chunks: Buffer[] = []

        // If there's existing data, download it first
        if (upload.offset > 0) {
          try {
            const existingFile = await BunnyStorageSDK.file.get(this.storageZone, id)
            const {stream: existingWebStream} = await existingFile.data()
            const existingNodeStream = webStreamToNodeStream(existingWebStream)

            for await (const chunk of existingNodeStream) {
              chunks.push(chunk)
            }
          } catch (error) {
            log(`[${id}] error downloading existing file:`, error)
            // If file doesn't exist yet, that's okay for offset 0
            if (upload.offset > 0) {
              isResolved = true
              return reject(ERRORS.FILE_WRITE_ERROR)
            }
          }
        }

        // Check again if stream was destroyed during async operations
        if (readable.destroyed) {
          isResolved = true
          return reject(ERRORS.FILE_WRITE_ERROR)
        }

        // Read new data
        readable.on('data', (buffer: Buffer) => {
          if (isResolved) return
          chunks.push(buffer)
          bytesReceived += buffer.length
        })

        readable.on('end', async () => {
          if (isResolved) return
          hasEnded = true
          try {
            // Combine all chunks
            const combinedBuffer = Buffer.concat(chunks)
            const newOffset = upload.offset + bytesReceived

            upload.offset = newOffset

            // Upload the combined file
            const combinedStream = new stream.Readable({
              read() {
                this.push(combinedBuffer)
                this.push(null)
              },
            })

            const uploadOptions: BunnyStorageSDK.file.UploadOptions = {}
            if (upload.metadata?.contentType) {
              uploadOptions.contentType = upload.metadata.contentType
            }

            await BunnyStorageSDK.file.upload(
              this.storageZone,
              id,
              nodeStreamToWebStream(combinedStream),
              uploadOptions
            )

            // Update metadata
            await this.#saveMetadata(upload)

            log(`[${id}] ${newOffset} bytes written`)
            isResolved = true
            resolve(newOffset)
          } catch (error) {
            if (isResolved) return
            log(`[${id}] error writing file:`, error)
            isResolved = true
            reject(ERRORS.FILE_WRITE_ERROR)
          }
        })

        readable.on('error', (error) => {
          if (isResolved) return
          log(`[${id}] stream error:`, error)
          isResolved = true
          reject(ERRORS.FILE_WRITE_ERROR)
        })

        readable.on('close', () => {
          // Only reject if stream was destroyed and we haven't received 'end' event
          // (which means it was destroyed prematurely)
          if (isResolved) return
          if (readable.destroyed && !hasEnded) {
            log(`[${id}] stream was destroyed before completion`)
            isResolved = true
            reject(ERRORS.FILE_WRITE_ERROR)
          }
        })
      } catch (error) {
        if (isResolved) return
        log(`[${id}] write error:`, error)
        isResolved = true
        reject(ERRORS.FILE_WRITE_ERROR)
      }
    })
  }

  async getUpload(id: string): Promise<Upload> {
    if (!id) {
      throw ERRORS.FILE_NOT_FOUND
    }

    try {
      const metadata = await this.#getMetadata(id)
      const upload = metadata.file

      // Get the actual file size from storage
      try {
        const fileInfo = await BunnyStorageSDK.file.get(this.storageZone, id)
        upload.offset = fileInfo.length
      } catch (error) {
        // If file doesn't exist yet, offset is 0
        upload.offset = 0
      }

      return upload
    } catch (error) {
      log('[BunnyStore] getUpload error', error)
      throw ERRORS.FILE_NOT_FOUND
    }
  }

  async declareUploadLength(id: string, upload_length: number): Promise<void> {
    const upload = await this.getUpload(id)

    upload.size = upload_length

    await this.#saveMetadata(upload)
  }
}
