import { normalize, join } from 'path'
import Bluebird from 'bluebird'
import { Buffer } from 'buffer'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { spawn } from 'child_process'
import { Stream as Needle } from 'nigel'
import { Logger } from './logger'
import {
  readFileAsync,
  writeFileAsync,
  pathExistsAsync,
  dequote,
  isWindows
} from './util'

const isBsd = Boolean(~process.platform.indexOf('bsd'))
const make = isWindows ? 'vcbuild.bat' : isBsd ? 'gmake' : 'make'
const configure = isWindows ? 'configure' : './configure'
const marker = Buffer.from('<nexe~sentinel>').toString('hex')
const tail = `\n//${marker}`
const needle = Buffer.from(marker)
const fixedIntegerLength = 10
const padLeft = (x, l = fixedIntegerLength, c = '0') => (c.repeat(l) + x).slice(-l)
const inflate = (value, size) => {
  if (!size || value.length >= size) {
    return value
  }
  return value + ' '.repeat(size - value.length)
}

export class NexeCompiler {
  constructor (options) {
    this.start = Date.now()
    const { python } = this.options = options
    this.log = new Logger(options.loglevel)
    this.src = join(options.temp, options.version)
    this.env = Object.assign({}, process.env)
    this.files = []
    this.nodeSrcBinPath = isWindows
      ? join(this.src, 'Release', 'node.exe')
      : join(this.src, 'out', 'Release', 'node')

    if (python) {
      if (isWindows) {
        this.env.PATH = '"' + dequote(normalize(python)) + '";' + this.env.PATH
      } else {
        this.env.PYTHON = python
      }
    }

    this.readFileAsync = async (file) => {
      let cachedFile = this.files.find(x => normalize(x.filename) === normalize(file))
      if (!cachedFile) {
        cachedFile = {
          filename: file,
          contents: await readFileAsync(join(this.src, file), 'utf-8')
            .catch({ code: 'ENOENT' }, () => '')
        }
        this.files.push(cachedFile)
      }
      return cachedFile
    }
    this.writeFileAsync = (file, contents) => writeFileAsync(join(this.src, file), contents)
    this.replaceInFileAsync = async (file, ...replacements) => {
      const entry = await this.readFileAsync(file)
      entry.contents = entry.contents.replace(...replacements)
    }
    this.setFileContentsAsync = async (file, contents) => {
      const entry = await this.readFileAsync(file)
      entry.contents = contents
    }
  }

  quit (code = 0) {
    const time = Date.now() - this.start
    this.log.write(`Finsihed in ${time / 1000}s`)
    return this.log.flush().then(x => process.exit(code))
  }

  _findPaddingSize (size, override = this.options.padding) {
    if (override === 0) {
      return 0
    }
    size = override > size ? override : size
    const padding = [3, 6, 9, 16, 25, 40].map(x => x * 1e6).find(p => size <= p)
    if (!padding) {
      throw new Error(`No prebuilt target large enough (${(size / 1024).toFixed(2)}Mb).\nUse the --build flag and build for the current platform`)
    }
    return padding
  }

  _getNodeExecutableLocation (target) {
    if (target) {
      return join(this.options.temp, target)
    }
    return this.nodeSrcBinPath
  }

  _runBuildCommandAsync (command, args) {
    return new Bluebird((resolve, reject) => {
      spawn(command, args, {
        cwd: this.src,
        env: this.env,
        stdio: 'ignore'
      })
      .once('error', reject)
      .once('close', resolve)
    })
  }

  _configureAsync () {
    return this._runBuildCommandAsync(
      this.env.PYTHON || 'python',
      [configure, ...this.options.configure]
    )
  }

  async _buildAsync () {
    this.compileStep.log(`Configuring node build: ${this.options.configure}`)
    await this._configureAsync()
    const buildOptions = isWindows ? this.options.vcBuild : this.options.make
    this.compileStep.log(`Compiling Node with arguments: ${buildOptions}`)
    await this._runBuildCommandAsync(make, buildOptions)
    return createReadStream(this._getNodeExecutableLocation())
  }

  _fetchPrebuiltBinaryAsync () {
    return this._buildAsync()
  }

  _getPayload (header) {
    return this._serializeHeader(header) + this.input + '/**' + this.resources.bundle + `**/`
  }

  _generateHeader () {
    const zeros = padLeft(0)
    const version = ['configure', 'vcBuild', 'make'].reduce((a, c) => {
      return (a += this.options[c].slice().sort().join())
    }, '') + this.options.enableNodeCli
    const header = {
      version: padLeft(0, 32),
      resources: this.resources.index,
      contentSize: zeros,
      paddingSize: zeros,
      resourceOffset: zeros,
      binaryOffset: zeros
    }
    const serializedHeader = this._serializeHeader(header)
    header.contentSize = padLeft(Buffer.byteLength(this._getPayload(header)))
    header.paddingSize = padLeft(this._findPaddingSize(+header.contentSize))
    header.resourceOffset = padLeft(Buffer.byteLength(serializedHeader + this.input + '/**'))
    header.version = createHash('md5').update(version + header.paddingSize).digest('hex')
    return header
  }

  async _getExistingBinaryHeaderAsync (target) {
    const filename = this._getNodeExecutableLocation(target)
    const existingBinary = await pathExistsAsync(filename)
    if (existingBinary) {
      return this._extractHeaderAsync(filename)
    }
    return null
  }

  _extractHeaderAsync (path) {
    const binary = createReadStream(path)
    const haystack = new Needle(needle)
    let needles = 0
    let stackCache = []
    return new Promise((resolve, reject) => {
      binary.on('error', reject).pipe(haystack)
        .on('error', reject)
        .on('close', () => reject(new Error(`Binary: ${path} is not compatible with nexe`)))
        .on('haystack', x => needles && stackCache.push(x))
        .on('needle', () => {
          if (++needles === 2) {
            resolve(JSON.parse(Buffer.concat(stackCache).toString()))
            binary.close()
            haystack.end()
          }
        })
    })
  }

  _serializeHeader (header) {
    return `/**${marker}${JSON.stringify(header)}${marker}**/process.__nexe=${JSON.stringify(header)};`
  }

  async setMainModule (compiler, next) {
    await next()
    const header = compiler._generateHeader()
    const contents = inflate(this._getPayload(header), +header.paddingSize) + tail
    return compiler.setFileContentsAsync(`lib/${compiler.options.name}.js`, contents)
  }

  async compileAsync () {
    const step = this.compileStep = this.log.step('Compiling result')
    let target = this.options.targets.slice().shift()
    let prebuiltBinary = null
    const header = this._generateHeader()
    target = target && `${target}-${header.version.slice(0, 6)}`
    step.log(`Scanning existing binary...`)
    const existingHeader = await this._getExistingBinaryHeaderAsync(target)
    if (existingHeader && existingHeader.version === header.version) {
      const location = this._getNodeExecutableLocation(target)
      step.log(`Source already built: ${location}`)
      prebuiltBinary = createReadStream(location)
    }
    if (target) {
      throw new Error('\nNot Implemented, use --build during beta')
      // prebuiltBinary = await this._fetchPrebuiltBinaryAsync(target)
    }
    if (!prebuiltBinary) {
      prebuiltBinary = await this._buildAsync()
      step.log('Node binary compiled')
    }
    return this._assembleDeliverable(
      header,
      prebuiltBinary
    )
  }

  _assembleDeliverable (header, binary) {
    const haystack = new Needle(Buffer.concat([Buffer.from('/**'), needle]))
    const artifact = new Readable({ read () {} })
    let needles = 0
    let currentStackSize = 0
    binary.pipe(haystack)
    haystack
      .on('close', () => artifact.push(null))
      .on('needle', () => ++needles && haystack.needle(needle))
      .on('haystack', x => {
        if (!needles) {
          currentStackSize += x.length
          artifact.push(x)
        }
        if (needles === 1 && !+header.binaryOffset) {
          header.binaryOffset = padLeft(currentStackSize)
          const content = Buffer.from(inflate(this._getPayload(header), +header.paddingSize) + tail)
          artifact.push(content)
        }
        if (needles > 2) {
          artifact.push(x)
        }
      })
    return artifact
  }
}
