/**
 * 网络下载模块（幻响服务器武器下载）
 *
 * 数据源：腾讯云 COS weapons-catalog.json
 *   https://wrap-fx-assets-1327887151.cos.ap-shanghai.myqcloud.com/weapons-catalog.json
 *
 * 下载方式：@system.request.download 系统级下载
 *   - 由系统处理二进制下载（不依赖 fetch arraybuffer，可靠）
 *   - onDownloadComplete 返回文件 uri，再 move/copy 到 audiosync 存储目录
 *
 * 冷却时间：服务器 JSON 未提供可靠冷却字段，故下载完成后自动解析
 *   每个音频真实总长（MP3 帧头解析，失败回退 32kbps 估算），
 *   冷却 = 音频总长 + 400ms，写入清单条目。
 *
 * 存储（与 audiosync 模块共用）：
 *   音频文件 → internal://files/audiosync/<file>
 *   封面图标 → internal://files/audiosync/images/<icon>
 *   清单     → storage key: audiosync_manifest（通过 audiosync.importEntry）
 */
import fetch from '@system.fetch'
import file from '@system.file'
import request from '@system.request'
import storage from '@system.storage'
import audioSync from './audiosync'

const COS_BASE_URL = 'https://wrap-fx-assets-1327887151.cos.ap-shanghai.myqcloud.com'
const CATALOG_URL = COS_BASE_URL + '/weapons-catalog.json'
const AUDIO_DIR = 'internal://files/audiosync/'
const IMAGE_DIR = 'internal://files/audiosync/images/'
const FALLBACK_BITRATE = 32 // 回退估算比特率（kbps）
const TAIL_TAG_SIZE = 128 // 尾部 ID3v1/APE 标签兜底字节
const COOLDOWN_PADDING = 400 // 冷却 = 音频时长 + 400ms
const AUDIO_HEADER_LEN = 8192 // 时长解析只读文件头部字节数（ID3v2 标签 + 首帧头）

// GitHub Pages 三仓库分发（Heihade_index 定时生成 catalog.json）
// 三级回退策略：域名直连 → jsdelivr CDN → IP 直连
// 用户可在「网络连接设置」页选择首选连接方式（connection_settings）
const GITHUB_DOMAIN = 'https://MinimumBubble11.github.io'
const GITHUB_HOST = 'MinimumBubble11.github.io'
const JSDIVELR_BASE = 'https://cdn.jsdelivr.net/gh/MinimumBubble11'
const GITHUB_IP = 'https://185.199.111.153'

// 用户连接设置（由连接设置页写入 storage：connection_settings）
//   mode: 'domain' | 'cdn' | 'ip' —— 首选连接方式
//   customIp: 自定义 IP（ip 模式使用，也作为回退 IP）
//   addHostHeader: ip 模式是否携带 Host 头
//   autoSwitch: 首选方式失败时是否自动尝试其他方式（默认 true）
const CONNECTION_SETTINGS_KEY = 'connection_settings'
const DEFAULT_IP = '185.199.111.153'
let _userConnectionMode = 'domain'
let _userCustomIp = DEFAULT_IP
let _userAddHostHeader = true
let _userAutoSwitch = true
let _settingsLoaded = false
let _settingsLoading = false // 设置读取进行中（异步 storage.get 未完成）
let _settingsCallbacks = []  // 等待设置加载完成后执行的回调队列

function resolveUrl(url) {
  return url && url.indexOf('/') === 0 ? COS_BASE_URL + url : url
}

function basename(path) {
  const parts = String(path || '').split('/')
  return parts[parts.length - 1] || ''
}

// 兼容 file.readArrayBuffer 返回形态 → Uint8Array
function toU8(buf) {
  if (!buf) return null
  if (buf instanceof Uint8Array) return buf
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf)
  if (typeof buf === 'object' && buf.buffer instanceof ArrayBuffer) {
    return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.buffer.byteLength)
  }
  if (Array.isArray(buf)) return new Uint8Array(buf)
  return null
}

// MP3 帧头解析 → 时长(ms)；解析失败返回 0
// 算法：跳过 ID3v2 → 定位同步字 → 解析首帧比特率/采样率
//   时长 = 有效字节 × 8 / 比特率(kbps)
// u8 为文件头部字节（无需整文件读入内存）；totalSize 为文件总字节（来自 file.get）
function parseMp3Duration(u8, totalSize) {
  if (!u8 || u8.length < 100) return 0
  let offset = 0
  // 1. 跳过 ID3v2 标签（6~9 字节 syncsafe 长度）
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33 && u8.length >= 10) {
    offset = 10
      + ((u8[6] & 0x7f) << 21)
      + ((u8[7] & 0x7f) << 14)
      + ((u8[8] & 0x7f) << 7)
      + (u8[9] & 0x7f)
  }
  // 2. 扫描同步字 0xFF E0~FF
  let pos = offset
  while (pos < u8.length - 4) {
    if (u8[pos] === 0xff && (u8[pos + 1] & 0xe0) === 0xe0) break
    pos++
  }
  if (pos >= u8.length - 4) return 0
  // 3. 解析帧头 4 字节
  const b1 = u8[pos + 1]
  const b2 = u8[pos + 2]
  const versionId = (b1 >> 3) & 0x03 // 3=V1, 2=V2, 0=V2.5
  const layer = (b1 >> 1) & 0x03 // 1=Layer III
  if (versionId === 1 || layer !== 1) return 0
  const bitrateIdx = (b2 >> 4) & 0x0f
  const sampleIdx = (b2 >> 2) & 0x03
  const v1 = (versionId === 3)
  const bitrateTable = v1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const sampleTable = (versionId === 0)
    ? [11025, 12000, 8000]
    : v1 ? [44100, 48000, 32000] : [22050, 24000, 16000]
  const bitrate = bitrateTable[bitrateIdx] || 0
  const sampleRate = sampleTable[sampleIdx] || 0
  if (!bitrate || !sampleRate) return 0
  // 4. 有效字节 = 文件总字节 - ID3 标签 - 尾部标签
  //    u8 仅包含文件头部，总字节数由调用方传入（file.get 的 length）
  const fileLen = (totalSize > 0) ? totalSize : u8.length
  const effectiveBytes = Math.max(0, fileLen - offset - TAIL_TAG_SIZE)
  return Math.floor(effectiveBytes * 8 / bitrate)
}

// 回退估算（32kbps）
function estimateDuration(bytesLen) {
  return Math.floor(Math.max(0, (bytesLen || 0) - TAIL_TAG_SIZE) * 8 / FALLBACK_BITRATE)
}

export default {
  _catalog: null,
  _audioSizes: [],
  _ipFallback: false,
  _currentLayer: 0, // 当前回退层级（1=域名, 2=CDN, 3=IP）

  // 同步更新用户连接设置（连接设置页保存后调用，立即生效，无需等待异步 storage）
  syncUserSettings(settings) {
    if (!settings) return
    _userConnectionMode = settings.mode || 'domain'
    _userCustomIp = settings.customIp || DEFAULT_IP
    _userAddHostHeader = settings.addHostHeader !== false
    _userAutoSwitch = settings.autoSwitch !== false
    _settingsLoaded = true
    console.log('[download] 用户连接设置已同步: mode=' + _userConnectionMode + ' ip=' + _userCustomIp + ' autoSwitch=' + _userAutoSwitch)
  },

  // 供下载页读取当前连接方式
  getConnectionMode() {
    return _userConnectionMode
  },

  // 供下载页读取自动换位（自动切换）状态
  isAutoSwitchEnabled() {
    return _userAutoSwitch
  },

  // 供下载页切换自动换位（立即生效并持久化）
  setAutoSwitch(flag, cb) {
    _userAutoSwitch = !!flag
    _settingsLoaded = true
    const that = this
    storage.get({
      key: CONNECTION_SETTINGS_KEY,
      success: (data) => {
        let settings = {}
        if (data) {
          try { settings = JSON.parse(data) || {} } catch (e) { settings = {} }
        }
        settings.autoSwitch = _userAutoSwitch
        storage.set({
          key: CONNECTION_SETTINGS_KEY,
          value: JSON.stringify(settings),
          success: () => cb && cb(),
          fail: () => cb && cb()
        })
      },
      fail: () => {
        // 无现有设置，写入最小配置
        storage.set({
          key: CONNECTION_SETTINGS_KEY,
          value: JSON.stringify({
            mode: _userConnectionMode,
            customIp: _userCustomIp,
            addHostHeader: _userAddHostHeader,
            autoSwitch: _userAutoSwitch
          }),
          success: () => cb && cb(),
          fail: () => cb && cb()
        })
      }
    })
  },

  // 供下载页重置连接设置为默认（域名直连 + 自动换位开启）
  resetConnectionSettings(cb) {
    _userConnectionMode = 'domain'
    _userCustomIp = DEFAULT_IP
    _userAddHostHeader = true
    _userAutoSwitch = true
    _settingsLoaded = true
    storage.set({
      key: CONNECTION_SETTINGS_KEY,
      value: JSON.stringify({ mode: 'domain', customIp: DEFAULT_IP, addHostHeader: true, autoSwitch: true }),
      success: () => {
        console.log('[download] 连接设置已重置为默认')
        cb && cb()
      },
      fail: () => cb && cb()
    })
  },

  // 从本地存储读取用户连接设置（幂等）
  // 注意：storage.get 为异步，URL 构建前必须等待读取完成（回调排队），
  // 否则首次使用仍会按默认方式构建，导致用户切换的连接方式不生效。
  _loadUserSettings(cb) {
    if (_settingsLoaded) {
      cb && cb()
      return
    }
    if (_settingsLoading) {
      cb && _settingsCallbacks.push(cb)
      return
    }
    const that = this
    _settingsLoading = true
    const done = () => {
      _settingsLoaded = true
      _settingsLoading = false
      const cbs = _settingsCallbacks
      _settingsCallbacks = []
      cbs.forEach((fn) => {
        try { fn && fn() } catch (e) { console.error('[download] 设置回调异常', e) }
      })
      cb && cb()
    }
    storage.get({
      key: CONNECTION_SETTINGS_KEY,
      success: (data) => {
        if (data) {
          try {
            const settings = JSON.parse(data)
            that.syncUserSettings(settings)
          } catch (e) {
            console.error('[download] 解析连接设置失败', e)
          }
        }
        done()
      },
      fail: (err) => {
        console.error('[download] 读取连接设置失败', err)
        done()
      }
    })
  },

  // 根据用户设置解析主 URL（首选连接方式）
  _resolveUrlByUserSettings(url) {
    if (!url) return url
    switch (_userConnectionMode) {
      case 'cdn':
        return this._resolveToJsdelivr(url)
      case 'ip':
        return url.replace(GITHUB_DOMAIN, 'https://' + _userCustomIp)
      default:
        return url
    }
  },

  // 启用/关闭 GitHub 备用 IP 直连（域名被 DNS 污染时由下载页调用）
  setIpFallback(flag) {
    this._ipFallback = !!flag
  },

  // 将 GitHub Pages URL 转换为 jsdelivr CDN URL
  _resolveToJsdelivr(url) {
    if (!url) return url
    
    // 匹配 GitHub Pages URL 格式
    const pattern = /^https:\/\/MinimumBubble11\.github\.io\/(Heihade_\w+)\//
    const match = url.match(pattern)
    
    if (match) {
      const repoName = match[1]
      const path = url.substring(match[0].length)
      return `${JSDIVELR_BASE}/${repoName}@HEAD/${path}`
    }
    
    // 非 GitHub Pages URL，返回原样
    return url
  },

  // 为单个 URL 构建三级回退 URL 列表（用户首选模式排在最前，失败自动回退）
  _buildFallbackUrls(url) {
    if (!url) return []

    const domainUrl = url
    const cdnUrl = this._resolveToJsdelivr(url)
    // 回退 IP 始终用自定义 IP（用户设置，默认官方 IP）
    const ipUrl = url.replace(GITHUB_DOMAIN, 'https://' + _userCustomIp)

    // 自动切换关闭时，仅返回首选方式
    if (!_userAutoSwitch) {
      switch (_userConnectionMode) {
        case 'cdn':
          return [cdnUrl]
        case 'ip':
          return [ipUrl]
        default:
          return [domainUrl]
      }
    }

    // 自动切换开启时，按顺序回退
    switch (_userConnectionMode) {
      case 'cdn':
        return [cdnUrl, domainUrl, ipUrl]
      case 'ip':
        return [ipUrl, domainUrl, cdnUrl]
      default:
        return [domainUrl, cdnUrl, ipUrl]
    }
  },

  // 根据 URL 判断是否需要 Host 头（IP 直连且开启自动 Host 时）
  _headerForUrl(url) {
    if (!url) return undefined
    const isIpUrl = url.indexOf(GITHUB_IP) === 0 || url.indexOf('https://' + _userCustomIp) === 0
    if (isIpUrl && _userAddHostHeader) {
      return { Host: GITHUB_HOST }
    }
    return undefined
  },

  // 根据层级获取请求头（仅 IP 直连需要 Host 头）
  _getHeaderForLayer(layer) {
    if (layer === 3) {
      return { Host: GITHUB_HOST }
    }
    return undefined
  },

  // IP 直连模式下：把 GitHub 域名替换为备用 IP（Host 头保持域名，证书与路由不变）
  _resolveGitHubUrl(url) {
    if (this._ipFallback && url && url.indexOf(GITHUB_DOMAIN) === 0) {
      return GITHUB_IP + url.substring(GITHUB_DOMAIN.length)
    }
    return url
  },

  // 访问备用 IP 时需携带 Host 头（HTTPS SNI 与路由依赖域名）
  _githubHeaders(url) {
    if (this._ipFallback && url && url.indexOf(GITHUB_IP) === 0) {
      return { Host: GITHUB_HOST }
    }
    return undefined
  },

  getCatalogUrl() {
    return CATALOG_URL
  },

  // ================= 目录 =================
  fetchCatalog(cb, catalogUrl) {
    const url = this._resolveGitHubUrl(catalogUrl || CATALOG_URL)
    fetch.fetch({
      url: url,
      method: 'GET',
      header: this._githubHeaders(url),
      responseType: 'json',
      success: (res) => {
        const data = (res && res.data) || {}
        const raw = data.weapons || {}
        const list = Object.keys(raw).map((key) => {
          const w = raw[key]
          return {
            id: key,
            index: w.index !== undefined ? w.index : 0,
            name: w.name || key,
            audioUrls: (w.audioUrls || []).map(resolveUrl),
            audioCount: (w.audioUrls || []).length,
            iconUrl: resolveUrl(w.iconUrl || ''),
            vibrationDuration: w.vibrationDuration || 1500,
            debounceTime: w.debounceTime || 0,
            // 播放模式：1=轮播(1,2)；2=Combo(1,1,1,2)（仅 2 音频有效，缺省 1）
            playMode: w.playMode === 2 ? 2 : 1,
            // 详情字段（列表展示 + 搜索匹配；分类仅搜索不展示）
            description: w.description || '',
            category: w.category || 'other',
            author: w.author || '官方'
          }
        })
        list.sort((a, b) => a.index - b.index)
        this._catalog = list
        cb && cb(list)
      },
      fail: (data, code) => {
        this._catalog = null
        // 打印网络错误代码（便于排查域名/IP 连通问题）
        console.error('[download] 拉取目录失败 url=' + url + ' code=' + code, data || '')
        cb && cb(null, code)
      }
    })
  },

  // 三级回退加载 catalog（应用用户连接设置）
  // 先确保连接设置已加载（异步），再按用户首选方式构建 URL 列表
  fetchCatalogWithFallback(cb, catalogUrl) {
    const that = this
    this._loadUserSettings(() => {
      const urls = this._buildFallbackUrls(catalogUrl || CATALOG_URL)
      this._fetchWithFallback(urls, 0, (list, finalLayer, lastErrorCode) => {
        that._currentLayer = finalLayer
        // 透传 finalLayer 和 lastErrorCode，供下载页识别最终使用的回退层级和错误码
        cb && cb(list, finalLayer, lastErrorCode)
      })
    })
  },

  // 带回退的 catalog 请求
  _fetchWithFallback(urls, index, cb, lastErrorCode) {
    if (index >= urls.length) {
      cb(null, 0, lastErrorCode)
      return
    }
    
    const url = urls[index]
    const header = this._headerForUrl(url)
    
    console.log(`[download] Trying layer ${index + 1}: ${url}`)
    
    fetch.fetch({
      url: url,
      method: 'GET',
      header: header,
      responseType: 'json',
      timeout: 6000, // 每层超时 6s，避免无网时长时间等待
      success: (res) => {
        const data = (res && res.data) || {}
        if (data.weapons) {
          const raw = data.weapons || {}
          const list = Object.keys(raw).map((key) => {
            const w = raw[key]
            return {
              id: key,
              index: w.index !== undefined ? w.index : 0,
              name: w.name || key,
              audioUrls: (w.audioUrls || []).map(resolveUrl),
              audioCount: (w.audioUrls || []).length,
              iconUrl: resolveUrl(w.iconUrl || ''),
              vibrationDuration: w.vibrationDuration || 1500,
              debounceTime: w.debounceTime || 0,
              playMode: w.playMode === 2 ? 2 : 1,
              description: w.description || '',
              category: w.category || 'other',
              author: w.author || '官方'
            }
          })
          list.sort((a, b) => a.index - b.index)
          this._catalog = list
          console.log(`[download] Layer ${index + 1} success`)
          cb && cb(list, index + 1)
        } else {
          // 数据格式异常，尝试下一层
          this._fetchWithFallback(urls, index + 1, cb, lastErrorCode)
        }
      },
      fail: (data, code) => {
        console.error(`[download] Layer ${index + 1} failed: code=${code}`)
        this._fetchWithFallback(urls, index + 1, cb, code)
      }
    })
  },

  // ================= 已下载判断 =================
  isDownloaded(id, cb) {
    audioSync.load((list) => {
      const hit = (list || []).some((x) => x.id === id)
      cb && cb(!!hit)
    })
  },

  // ================= 系统级下载单个文件到目标目录 =================
  // url 下载地址，filename 目标文件名，destDir 目标目录（internal://.../）
  // cb(err, destUri)：err 为错误码（成功为 null）
  _downloadBySystem(url, filename, destDir, cb) {
    // 确保目录存在
    file.mkdir({ uri: destDir, recursive: true, success: () => {}, fail: () => {} })
    request.download({
      url: url,
      filename: filename, // [1010+] 指定文件名；低版本默认取 url 文件名
      header: this._githubHeaders(url), // IP 直连时携带 Host 头
      success: (data) => {
        const token = data && data.token
        if (!token) {
          cb && cb(1001)
          return
        }
        request.onDownloadComplete({
          token: token,
          success: (d) => {
            const srcUri = d && d.uri
            if (!srcUri) {
              cb && cb(1000)
              return
            }
            const destUri = destDir + audioSync.sanitizeFileName(filename)
            // 优先移动（释放系统下载目录空间），跨目录失败则复制
            file.move({
              srcUri: srcUri,
              dstUri: destUri,
              success: () => {
                cb && cb(null, destUri)
              },
              fail: () => {
                file.copy({
                  srcUri: srcUri,
                  dstUri: destUri,
                  success: () => {
                    // 复制成功后清理系统下载目录源文件
                    file.delete({ uri: srcUri, success: () => {}, fail: () => {} })
                    cb && cb(null, destUri)
                  },
                  fail: (e2, c2) => {
                    cb && cb(c2 || 300)
                  }
                })
              }
            })
          },
          fail: (err, code) => {
            console.error('[download] 下载完成回调失败 url=' + url + ' code=' + code, err || '')
            cb && cb(code || 1000)
          }
        })
      },
      fail: (err, code) => {
        console.error('[download] 下载请求失败 url=' + url + ' code=' + code, err || '')
        cb && cb(code)
      }
    })
  },

  // 带回退的系统级下载
  _downloadBySystemWithFallback(urls, index, filename, destDir, cb) {
    if (index >= urls.length) {
      cb && cb('所有下载方式均失败')
      return
    }
    
    const url = urls[index]
    const layer = Math.floor(index / 3) + 1
    const header = this._headerForUrl(url)
    
    console.log(`[download] Downloading layer ${layer}: ${url}`)
    
    // 确保目录存在
    file.mkdir({ uri: destDir, recursive: true, success: () => {}, fail: () => {} })
    request.download({
      url: url,
      filename: filename,
      header: header,
      success: (data) => {
        const token = data && data.token
        if (!token) {
          // 下载失败，尝试下一层
          this._downloadBySystemWithFallback(urls, index + 1, filename, destDir, cb)
          return
        }
        request.onDownloadComplete({
          token: token,
          success: (d) => {
            const srcUri = d && d.uri
            if (!srcUri) {
              this._downloadBySystemWithFallback(urls, index + 1, filename, destDir, cb)
              return
            }
            const destUri = destDir + audioSync.sanitizeFileName(filename)
            file.move({
              srcUri: srcUri,
              dstUri: destUri,
              success: () => {
                console.log(`[download] Layer ${layer} success`)
                cb && cb(null, destUri)
              },
              fail: () => {
                file.copy({
                  srcUri: srcUri,
                  dstUri: destUri,
                  success: () => {
                    file.delete({ uri: srcUri, success: () => {}, fail: () => {} })
                    console.log(`[download] Layer ${layer} success (copy)`)
                    cb && cb(null, destUri)
                  },
                  fail: (e2, c2) => {
                    this._downloadBySystemWithFallback(urls, index + 1, filename, destDir, cb)
                  }
                })
              }
            })
          },
          fail: (err, code) => {
            console.error(`[download] Layer ${layer} failed: code=${code}`)
            this._downloadBySystemWithFallback(urls, index + 1, filename, destDir, cb)
          }
        })
      },
      fail: (err, code) => {
        console.error(`[download] Layer ${layer} failed: code=${code}`)
        this._downloadBySystemWithFallback(urls, index + 1, filename, destDir, cb)
      }
    })
  },

  // 查询文件大小（供清单 size 展示）
  _fileSize(uri, cb) {
    file.get({
      uri: uri,
      success: (data) => {
        cb && cb((data && data.length) || 0)
      },
      fail: () => {
        cb && cb(0)
      }
    })
  },

  // ================= 音频时长解析 =================
  // 只读本地音频文件头部（兼容返回形态），避免整文件读入内存
  _readAudioHeader(uri, cb) {
    file.readArrayBuffer({
      uri: uri,
      position: 0,
      length: AUDIO_HEADER_LEN,
      success: (data) => {
        cb && cb(toU8(data && data.buffer))
      },
      fail: () => {
        cb && cb(null)
      }
    })
  },

  // 解析单个音频时长：MP3 帧头解析，失败回退 32kbps 估算
  // 只读取文件头部（ID3v2 + 首帧头）与总大小，不整文件读入内存
  _resolveAudioDuration(uri, cb) {
    // 1. 先获取文件总大小（仅元数据，廉价）
    this._fileSize(uri, (totalSize) => {
      if (!totalSize) {
        cb && cb(0)
        return
      }
      // 2. 只读文件头部解析帧头；有效字节 = 总大小 - 标签偏移
      this._readAudioHeader(uri, (bytes) => {
        if (!bytes || bytes.length === 0) {
          cb && cb(0)
          return
        }
        const ms = parseMp3Duration(bytes, totalSize)
        if (ms > 0) {
          cb && cb(ms)
        } else {
          cb && cb(estimateDuration(totalSize))
        }
      })
    })
  },

  // 下载完成后解析全部音频时长（逐个读取，pending 聚合）
  _resolveAllDurations(files, cb) {
    const that = this
    if (!files || files.length === 0) {
      cb && cb([])
      return
    }
    let pending = files.length
    const durations = []
    files.forEach((f, i) => {
      const uri = AUDIO_DIR + audioSync.sanitizeFileName(f)
      this._resolveAudioDuration(uri, (ms) => {
        durations[i] = ms || 0
        pending--
        if (pending === 0) cb && cb(durations)
      })
    })
  },

  // ================= 下载整个武器（图标 + 全部音效） =================
  // weapon: { id, name, audioUrls, audioCount, iconUrl, vibrationDuration, debounceTime }
  // opts: { onProgress(percent), onComplete(entry), onError(msg) }
  downloadWeapon(weapon, opts) {
    opts = opts || {}
    const that = this
    // 先确保连接设置已加载（异步），再按用户首选方式构建下载 URL
    this._loadUserSettings(() => {
      that._downloadWeaponWithSettings(weapon, opts)
    })
  },

  // 连接设置加载完成后的实际下载流程
  _downloadWeaponWithSettings(weapon, opts) {
    // 构建音频三级回退 URL 列表
    const audioUrls = []
    ;(weapon.audioUrls || []).forEach(url => {
      audioUrls.push(...this._buildFallbackUrls(url))
    })
    
    // 构建图标三级回退 URL 列表
    const iconUrls = this._buildFallbackUrls(weapon.iconUrl)
    
    if (audioUrls.length === 0) {
      opts.onError && opts.onError('无音频文件')
      return
    }
    
    const files = (weapon.audioUrls || []).map((u) => basename(u))
    const iconName = weapon.iconUrl ? basename(weapon.iconUrl) : ''
    // 总下载项：图标(1) + 音频(N)，用于按文件数显示进度
    const totalItems = (iconName ? 1 : 0) + (weapon.audioUrls || []).length
    let doneItems = 0
    let idx = 0
    let iconDone = false
    let finished = false
    const that = this

    const reportProgress = () => {
      const percent = totalItems > 0 ? Math.min(99, Math.round((doneItems / totalItems) * 100)) : 0
      opts.onProgress && opts.onProgress(percent)
    }

    const finish = (ok) => {
      if (finished) return
      finished = true
      if (!ok) {
        opts.onError && opts.onError('部分文件下载失败')
        return
      }
      // 下载完成：先解析全部音频时长，再构造条目（冷却 = 时长 + 400ms）
      this._resolveAllDurations(files, (durations) => {
        const entry = this._buildEntry(weapon, files, iconName, durations)
        audioSync.importEntry(entry, () => {
          opts.onProgress && opts.onProgress(100)
          opts.onComplete && opts.onComplete(entry)
        })
      })
    }

    const downloadIcon = () => {
      if (!iconName) {
        iconDone = true
        run()
        return
      }
      this._downloadBySystemWithFallback(iconUrls, 0, iconName, IMAGE_DIR, (err) => {
        if (err) console.error('图标下载失败', err)
        doneItems++
        reportProgress()
        iconDone = true
        run()
      })
    }

    const downloadAudio = () => {
      const fi = idx++
      const originalUrl = weapon.audioUrls[fi]
      const fallbackUrls = this._buildFallbackUrls(originalUrl)
      
      this._downloadBySystemWithFallback(fallbackUrls, 0, files[fi], AUDIO_DIR, (err, destUri) => {
        if (err) {
          console.error('音频下载失败', err)
        } else {
          // 记录音频文件大小（供 custom 页展示）
          that._fileSize(destUri, (size) => {
            that._audioSizes[fi] = size
          })
        }
        doneItems++
        reportProgress()
        run()
      })
    }

    const run = () => {
      if (!iconDone) {
        downloadIcon()
        return
      }
      if (idx >= (weapon.audioUrls || []).length) {
        finish(true)
        return
      }
      downloadAudio()
    }

    // 记录每个音频大小（构建清单时使用）
    this._audioSizes = []
    run()
  },

  // 构造清单条目（与 audiosync 模块 entry 格式一致）
  // durations[i] 为各音频真实时长(ms)；冷却 = 时长 + 400ms
  _buildEntry(weapon, files, iconName, durations) {
    const count = files.length
    const durs = durations || []
    const sizes = this._audioSizes || []
    // 2 音频 + playMode=2 → Combo 节奏 (1,1,1,2)：totalSteps=4
    // play.ux 已按 totalSteps 计算索引（与插件端模式链路一致），此处无需改播放页
    const combo = (count === 2 && weapon.playMode === 2)
    const entry = {
      id: weapon.id,
      name: weapon.name,
      mode: count > 1 ? 'sequence' : 'single',
      display: iconName ? 'image' : 'text',
      imageName: iconName || '',
      duration: 1500,
      cooldown: 1500 + COOLDOWN_PADDING,
      totalSteps: combo ? 4 : count,
      // 节奏标签：Combo→mode2，其余→mode1（旧数据缺字段向后兼容按 mode1）
      playPattern: combo ? 'mode2' : 'mode1',
      description: weapon.description || '',
      category: weapon.category || 'other',
      author: weapon.author || '官方',
      bgText: weapon.name,
      centerText: weapon.name,
      files: files.map((f, i) => {
        const dur = durs[i] || 0
        return {
          file: f,
          duration: dur,
          cooldown: dur + COOLDOWN_PADDING,
          size: sizes[i] || 0
        }
      }),
      size: sizes.reduce((a, b) => a + (b || 0), 0),
      sizeMismatch: false,
      time: Date.now()
    }
    // single：顶层 duration/cooldown 用第一个音频的真实时长
    if (count === 1) {
      const dur = durs[0] || 0
      entry.duration = dur
      entry.cooldown = dur + COOLDOWN_PADDING
    }
    this._audioSizes = []
    return entry
  }
}
