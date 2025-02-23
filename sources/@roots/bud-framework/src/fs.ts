import type {Bud} from '@roots/bud-framework'
import type {Contract} from '@roots/bud-framework/service'

import {Buffer} from 'node:buffer'
import {join} from 'node:path'

import {bind} from '@roots/bud-support/decorators/bind'
import {BudError} from '@roots/bud-support/errors'
import {Filesystem, json, yml} from '@roots/bud-support/filesystem'
import globby from '@roots/bud-support/globby'
import isBoolean from '@roots/bud-support/isBoolean'
import isNumber from '@roots/bud-support/isNumber'
import isString from '@roots/bud-support/isString'
import logger from '@roots/bud-support/logger'
import {S3} from '@roots/filesystem'

/**
 * {@link Filesystem} service
 */
export class FS extends Filesystem implements Contract {
  /**
   * JSON
   *
   * @see {@link https://bud.js.org/reference/bud.fs/json}
   */
  public json: typeof json = json

  /**
   * {@link Contract.label}
   */
  public label = `fs`

  /**
   * S3
   *
   * @see {@link https://bud.js.org/reference/bud.fs/s3}
   */
  public s3: S3

  /**
   * YML
   *
   * @see {@link https://bud.js.org/reference/bud.fs/yml}
   */
  public yml: typeof yml = yml

  /**
   * Class constructor
   */
  public constructor(public _app: () => Bud) {
    super(_app().context.basedir)
    this.s3 = new S3()
  }

  /**
   * {@link Contract.app}
   */
  public get app(): Bud {
    return this._app()
  }

  public catch(error: BudError | string): never {
    if (typeof error === `string`) {
      throw BudError.normalize(error)
    }

    throw error
  }

  /**
   * {@link Contract.done}
   */
  public done() {
    return this.app
  }

  /**
   * {@link Contract.logger}
   */
  public get logger(): typeof logger {
    return logger.scope(`fs`)
  }

  /**
   * Set bucket
   *
   * @param bucket - {@link S3.bucket}
   *
   * @see {@link https://bud.js.org/reference/bud.fs/s3#setup}
   */
  @bind
  public setBucket(bucket: string) {
    this.app.after(async () => {
      this.s3.config.set(`bucket`, bucket)
    })

    return this
  }

  /**
   * Set credentials
   *
   * @param credentials - {@link S3.credentials}
   *
   * @see {@link https://bud.js.org/reference/bud.fs/s3#setup}
   */
  @bind
  public setCredentials(credentials: S3[`config`][`credentials`]) {
    this.app.after(async () => {
      this.s3.config.set(`credentials`, credentials)
    })

    return this
  }

  /**
   * Set endpoint
   *
   * @param endpoint - S3 endpoint
   *
   * @see {@link https://bud.js.org/reference/bud.fs/s3#setup}
   */
  @bind
  public setEndpoint(endpoint: S3[`config`][`endpoint`]) {
    this.app.after(async () => {
      this.s3.config.set(`endpoint`, endpoint)
    })

    return this
  }

  /**
   * Set S3 region
   *
   * @param region - S3 region
   *
   * @see {@link https://bud.js.org/reference/bud.fs/s3#setup}
   */
  @bind
  public setRegion(region: S3[`config`][`region`]) {
    this.app.after(async () => {
      this.s3.config.set(`region`, region)
    })

    return this
  }

  /**
   * Upload files to S3
   *
   * @param options - upload options
   *
   * @see {@link https://bud.js.org/reference/bud.fs/s3#uploading-files}
   */
  @bind
  public upload(options?: {
    destination?: string
    files?: string
    keep?: false | number
    source?: string
  }): this {
    if (!this.s3.config.credentials) {
      throw BudError.normalize(
        `S3 is not configured. See https://bud.js.org/reference/bud.fs/s3`,
      )
    }

    const {destination, files, keep, source} = {
      destination: options?.destination,
      files: options?.files ?? `**/*`,
      keep:
        isNumber(options?.keep) || isBoolean(options?.keep)
          ? options?.keep
          : 5,
      source: options?.source ?? this.app.path(`@dist`),
    }

    const s3Path = (path: string) =>
      destination ? join(destination, path) : path

    this.app.after(async () => {
      // eslint-disable-next-line
      console.log(`Uploading...`)

      await globby(files, {cwd: source}).then(async files => {
        const descriptions = await Promise.all(
          files.map(async file => {
            const contents = await this.read(join(source, file), `buffer`)
            return {contents, file}
          }),
        )

        const manifestExists = await this.s3.exists(
          s3Path(`upload-manifest.json`),
        )

        const entries = Object.entries(
          manifestExists
            ? await this.s3
                .read(s3Path(`upload-manifest.json`))
                .then(this.json.parse)
            : {},
        )

        await Promise.all(
          descriptions.map(async ({contents, file}) => {
            this.logger.time(`Upload ${file} to ${this.s3.ident}`)

            try {
              await this.s3.write(s3Path(file), contents)
              this.logger.timeEnd(`Upload ${file} to ${this.s3.ident}`)
            } catch (error) {
              this.catch(error)
            }
          }),
        )

        if (typeof keep !== `number`) return

        const stale =
          keep > 1 ? entries.splice(0, entries.length - (keep - 1)) : []

        await Promise.all(
          [...new Set(stale)]
            .flatMap(([, value]) => value)
            .filter(
              key =>
                !entries.some(
                  ([_, value]) =>
                    Array.isArray(value) && value.includes(key),
                ),
            )
            .map(async key => {
              if (!isString(key)) return

              const fileExists = await this.s3.exists(key)
              if (!fileExists) return

              this.logger.time(
                `Remove ${key} from ${this.s3.ident} (stale)`,
              )
              await this.s3.delete(key)
              this.logger.timeEnd(
                `Remove ${key} from ${this.s3.ident} (stale)`,
              )
            }),
        )

        this.logger.time(`Write upload-manifest.json to ${this.s3.ident}`)

        await this.s3.write({
          Body: Buffer.from(
            this.json.stringify({
              ...entries.reduce((acc, [k, v]) => ({...acc, [k]: v}), {}),
              [new Date().getTime()]: descriptions.map(({file}) => file),
            }),
          ),
          Key: s3Path(`upload-manifest.json`),
        })

        this.logger.timeEnd(
          `Write upload-manifest.json to ${this.s3.ident}`,
        )
      })
    })

    return this
  }
}
