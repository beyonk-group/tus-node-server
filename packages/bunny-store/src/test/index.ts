import path from 'node:path'

import * as BunnyStorageSDK from '@bunny.net/storage-sdk'

import {BunnyStore} from '@beyonk/tus-bunny-store'

import * as shared from '../../../utils/dist/test/stores.js'

const fixturesPath = path.resolve('../', '../', 'test', 'fixtures')
const storePath = path.resolve('../', '../', 'test', 'output', 'bunny-store')

describe('BunnyStore', () => {
  before(function () {
    this.testFileSize = 960_244
    this.testFileName = 'test.mp4'
    this.storePath = storePath
    this.testFilePath = path.resolve(fixturesPath, this.testFileName)
  })

  beforeEach(function () {
    const storageZoneName = process.env.BUNNY_STORAGE_ZONE || 'test-zone'
    const accessKey = process.env.BUNNY_ACCESS_KEY || 'test-key'
    const region = BunnyStorageSDK.regions.StorageRegion.London

    const storageZone = BunnyStorageSDK.zone.connect_with_accesskey(
      region,
      storageZoneName,
      accessKey
    )

    this.datastore = new BunnyStore({
      storageZone,
    })
  })

  shared.shouldHaveStoreMethods()
  shared.shouldCreateUploads()
  shared.shouldWriteUploads()
  shared.shouldHandleOffset()
  shared.shouldDeclareUploadLength() // Creation-defer-length extension
})
