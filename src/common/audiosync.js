/**
 * 自定义音频同步模块（AstroBox v2 插件 ↔ 快应用）
 *
 * 通信链路：
 *   AstroBox 插件（手机/PC 端）通过 interconnect 的 send-qaic-message 接口
 *   向快应用包名（com.huashu.heihade）发送 JSON 字符串；
 *   快应用侧通过 @system.interconnect 的 connect.onmessage 接收；
 *   快应用变更清单后通过 connect.send 上报，供插件侧管理/删除。
 *
 * 协议（插件 → 快应用，均携带 "type":"audiosync"）：
 *   1. 开始同步（含播放模式/展示方式/传输单元列表）
 *      { "type":"audiosync","action":"start","id":"uuid","name":"音效名",
 *        "mode":"single"|"sequence","display":"image"|"text",
 *        "imageName":"cover.png","duration":1500,"cooldown":900,
 *        "totalSteps":4,"bgText":"","centerText":"","chunks":N,
 *        "units":[{"kind":"audio","file":"a.mp3","duration":1500}, ...] }
 *   2. 单元开始（每个音频/图片文件写入前）
 *      { "type":"audiosync","action":"unit-start","id":"uuid","unitIndex":0,
 *        "kind":"audio"|"image","file":"a.mp3","chunks":M,"size":S }
 *   3. 数据块（data 为 base64 编码的字节）
 *      { "type":"audiosync","action":"chunk","id":"uuid","unitIndex":0,
 *        "index":i,"data":"<base64>" }
 *   4. 同步结束
 *      { "type":"audiosync","action":"end","id":"uuid","ok":true }
 *   5. 删除指定音频（按同步 id）
 *      { "type":"audiosync","action":"delete","id":"<soundId>" }
 *   6. 远程播放
 *      { "type":"audiosync","action":"play","id":"<soundId>" }
 *   7. 清空全部
 *      { "type":"audiosync","action":"clear" }
 *
 * 协议（快应用 → 插件）：
 *   清单上报（同步/删除/清空后自动发送）
 *      { "type":"audiosync","action":"manifest","sounds":[{id,name,mode,file,size},...] }
 *
 * 建议：每个 chunk 的 base64 长度 ≤ 4000 字符（约 3KB 数据）。
 *
 * 存储：
 *   音频文件   → internal://files/audiosync/<file>
 *   封面图片   → internal://files/audiosync/images/<imageName>
 *   清单(JSON) → storage key: audiosync_manifest
 */
import file from '@system.file'
import storage from '@system.storage'
import audio from '@system.audio'
import interconnect from '@system.interconnect'

const AUDIO_DIR = 'internal://files/audiosync/'
const IMAGE_DIR = 'internal://files/audiosync/images/'
const MANIFEST_KEY = 'audiosync_manifest'
// 自定义/下载音效数量上限：超出时自动删除最旧条目（含其音频+封面文件），防止手表存储被占满。
// 2026-08-14：由 20 提高到 50；如需取消限制，改为一个极大值（如 9999）即可。
const MAX_SOUNDS = 9999

/**
 * base64 → Uint8Array
 * 纯 JS 实现，兼容不提供 atob / btoa 的运行时环境
 */
function base64ToBytes(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = []
  for (let i = 0; i < 256; i++) lookup[i] = -1
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i
  const clean = String(b64 || '').replace(/\s+/g, '')
  if (!clean) return new Uint8Array(0)
  let len = clean.length
  while (len > 0 && clean.charCodeAt(len - 1) === 61) len-- // 去掉尾部 '='
  const bytes = new Uint8Array(Math.floor((len * 6) / 8))
  let buffer = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < len; i++) {
    const val = lookup[clean.charCodeAt(i)]
    if (typeof val !== 'number' || val < 0) continue
    buffer = (buffer << 6) | val
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[o++] = (buffer >> bits) & 0xff
    }
  }
  return bytes
}

export default {
  _connect: null,
  _manifest: [],
  _manifestLoaded: false, // 清单内存缓存是否已加载（避免每次 onShow 全量重读 storage）
  _transfers: {},
  _listeners: [], // 状态变更订阅者（多订阅者，取代页面侧 500ms 轮询）

  getConnect() {
    if (!this._connect) {
      try {
        this._connect = interconnect.instance()
      } catch (e) {
        this._connect = null
      }
    }
    return this._connect
  },

  // 初始化存储目录（幂等）；全局消息接收已由 app.ux 统一注册，此处不再设置 onmessage
  // 同时创建封面图片目录，避免封面写入失败导致图片无法显示
  init() {
    file.mkdir({
      uri: AUDIO_DIR,
      recursive: true,
      success: function() {},
      fail: function() {}
    })
    file.mkdir({
      uri: IMAGE_DIR,
      recursive: true,
      success: function() {},
      fail: function() {}
    })
  },

  // ================= 事件订阅 =================
  // 订阅传输状态变更（start / unit-start / chunk / end / 清单变更均会触发）。
  // 返回注销函数，订阅者（页面/组件）必须在 onHide/onDestroy 调用，避免持有已销毁实例。
  // immediate 默认 true：订阅时立即回调一次，保证进入页面即可拿到当前进度。
  subscribe(cb, immediate) {
    if (typeof cb !== 'function') return function() {}
    if (this._listeners.indexOf(cb) === -1) this._listeners.push(cb)
    if (immediate !== false) {
      try { cb() } catch (e) {}
    }
    const that = this
    let done = false
    return function() {
      if (done) return
      done = true
      that.unsubscribe(cb)
    }
  },

  unsubscribe(cb) {
    const i = this._listeners.indexOf(cb)
    if (i >= 0) this._listeners.splice(i, 1)
  },

  // ================= 消息接收 =================
  handleMessage(data) {
    let raw = ''
    if (typeof data === 'string') {
      raw = data
    } else if (data && typeof data.data === 'string') {
      raw = data.data
    }
    if (!raw) return
    let obj = null
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      return
    }
    if (!obj || obj.type !== 'audiosync') return
    switch (obj.action) {
      case 'start': this.startSync(obj); break
      case 'unit-start': this.onUnitStart(obj); break
      case 'chunk': this.onChunk(obj); break
      case 'end': this.finishSync(obj.id); break
      case 'delete': this.removeById(obj.id); break
      case 'play': this.playById(obj.id); break
      case 'clear': this.clearAll(); break
      case 'request-manifest': this.reportFromStorage(); break
      default: break
    }
  },

  // 响应插件「刷新列表」：从 storage 强制重读最新落盘清单后上报
  reportFromStorage() {
    const that = this
    this.load(function() {
      that.reportManifest()
    }, true)
  },

  startSync(obj) {
    const id = obj.id || ('t' + Date.now())
    if (this._transfers[id]) {
      this.finishSync(id)
    }
    const units = Array.isArray(obj.units) ? obj.units : []
    this._transfers[id] = {
      id: id,
      name: obj.name || '未命名音效',
      mode: obj.mode === 'sequence' ? 'sequence' : 'single',
      display: obj.display || 'image',
      imageName: obj.imageName || '',
      duration: obj.duration || 1500,
      cooldown: obj.cooldown || 1000,
      totalSteps: obj.totalSteps || 0,
      bgText: obj.bgText || '',
      centerText: obj.centerText || '',
      units: units,
      totalChunks: obj.chunks || 0,
      doneChunks: 0,
      currentUnit: -1,
      currentKind: 'audio',
      currentFile: '',
      unitReceived: 0,
      unitChunks: 0,
      size: obj.size || 0
    }
    this.notify()
  },

  onUnitStart(obj) {
    const t = this._transfers[obj.id]
    if (!t) return
    const unitIndex = obj.unitIndex || 0
    t.currentUnit = unitIndex
    t.currentKind = (obj.kind === 'image') ? 'image' : 'audio'
    t.currentFile = this.sanitizeFileName(obj.file || 'audio.mp3')
    t.unitReceived = 0
    t.unitChunks = obj.chunks || 0
    this.notify()
  },

  unitPath(t) {
    if (t.currentKind === 'image') return IMAGE_DIR + t.currentFile
    return AUDIO_DIR + t.currentFile
  },

  onChunk(obj) {
    const t = this._transfers[obj.id]
    if (!t) return
    const unitIndex = obj.unitIndex !== undefined ? obj.unitIndex : 0
    if (unitIndex !== t.currentUnit) return
    const index = obj.index !== undefined ? obj.index : 0
    // 去重：同一单元同一 index 的分块只处理一次，防止插件重发导致文件尾部数据重复
    if (!t._receivedIdx) t._receivedIdx = {}
    const idxKey = unitIndex + ':' + index
    if (t._receivedIdx[idxKey]) return
    t._receivedIdx[idxKey] = true
    const bytes = base64ToBytes(obj.data)
    if (!bytes || bytes.length === 0) {
      // 空数据块：不落盘，直接计数
      t.unitReceived++
      this.checkUnitFinish(t, unitIndex)
      return
    }
    // 累计实际收到的字节数（供完整性校验：实际 vs 插件声明）
    if (!t._unitBytes) t._unitBytes = {}
    t._unitBytes[unitIndex] = (t._unitBytes[unitIndex] || 0) + bytes.length
    // 首个数据块覆盖写入（避免残留旧文件），后续追加；
    // 入队时立即递增计数（不等异步写入回调），避免插件连续发多个分块时
    // 被误判为“覆盖写”导致前面的数据全部丢失
    const isFirst = (t.unitReceived === 0)
    t.unitReceived++
    if (!t._queue) t._queue = []
    t._queue.push({ uri: this.unitPath(t), unitIndex: unitIndex, bytes: bytes, isFirst: isFirst })
    this.drainWriteQueue(t)
  },

  // 串行写入队列：同一文件严格按序 append，保证文件数据完整性
  drainWriteQueue(t) {
    if (t._writing || !t._queue || t._queue.length === 0) return
    t._writing = true
    const item = t._queue.shift()
    const that = this
    file.writeArrayBuffer({
      uri: item.uri,
      buffer: item.bytes,
      append: !item.isFirst,
      success: function() {
        t._writing = false
        that.checkUnitFinish(t, item.unitIndex)
        that.drainWriteQueue(t)
      },
      fail: function(data, code) {
        console.error('写入数据块失败 code=' + code)
        t._writing = false
        that.checkUnitFinish(t, item.unitIndex)
        that.drainWriteQueue(t)
      }
    })
  },

  checkUnitFinish(t, unitIndex) {
    t.doneChunks = (t.doneChunks || 0) + 1
    this.notify()
    if (t.unitChunks > 0 && t.unitReceived >= t.unitChunks) {
      // 当前单元完成；若还有下一单元，等待插件发送 unit-start
      if (unitIndex + 1 >= t.units.length) {
        this.finishSync(t.id)
      }
    }
  },

  finishSync(id) {
    const t = this._transfers[id]
    if (!t) return
    delete this._transfers[id]

    // 收集已写入的音频/图片文件
    const files = []
    let imageName = ''
    for (let i = 0; i < t.units.length; i++) {
      const u = t.units[i]
      if (u.kind === 'image') {
        imageName = this.sanitizeFileName(u.file)
      } else {
        files.push({
          file: this.sanitizeFileName(u.file),
          duration: u.duration || 1500,
          cooldown: u.cooldown || ((u.duration || 1500) + 400),
          size: u.size || 0
        })
      }
    }
    if (files.length === 0) return

    // 完整性校验：对比实际收到字节数与插件声明的大小（不等则文件可能不完整/重复）
    let sizeMismatch = false
    for (let i = 0; i < t.units.length; i++) {
      const u = t.units[i]
      if (u.kind === 'image') continue
      const expected = u.size || 0
      const received = (t._unitBytes && t._unitBytes[i]) || 0
      if (expected > 0 && received !== expected) {
        sizeMismatch = true
      }
    }

    const entry = {
      id: t.id,
      name: t.name,
      mode: t.mode,
      display: t.display,
      imageName: imageName,
      duration: t.duration,
      cooldown: t.cooldown || ((t.duration || 1500) + 400),
      totalSteps: t.totalSteps || files.length,
      bgText: t.bgText,
      centerText: t.centerText,
      files: files,
      size: t.size,
      sizeMismatch: sizeMismatch,
      time: Date.now()
    }
    // 保存前从 storage 重新加载最新清单合并，避免内存清单为空（应用刚启动/未加载）
    // 时直接覆盖导致之前上传的音频全部丢失
    const that = this
    this.load(function(stored) {
      let merged = stored.filter(function(x) { return x.id !== entry.id })
      merged.push(entry)
      // 数量上限：超出则删除最旧的（含其全部文件）
      while (merged.length > MAX_SOUNDS) {
        const old = merged.shift()
        that.deleteSoundFiles(old)
      }
      that._manifest = merged
      that.saveManifest()
      that.reportManifest()
      that.notify()
    })
  },

  // ================= 读取 =================
  // 清单读取（内存缓存 + storage 兜底）：
  //   所有写路径（importEntry/finishSync/removeById/clearAll）都会先更新内存 _manifest
  //   再落盘，因此内存一旦加载即为权威数据。
  //   force=true 时强制从 storage 重读（用于响应插件刷新等需落盘数据的场景）
  load(cb, force) {
    const that = this
    if (!force && this._manifestLoaded) {
      cb && cb(this._manifest)
      return
    }
    storage.get({
      key: MANIFEST_KEY,
      success: function(data) {
        that._manifest = that.parseManifest(data)
        that._manifestLoaded = true
        cb && cb(that._manifest)
      },
      fail: function() {
        that._manifest = []
        that._manifestLoaded = true
        cb && cb(that._manifest)
      }
    })
  },

  parseManifest(data) {
    if (!data) return []
    try {
      const arr = JSON.parse(data)
      return Array.isArray(arr) ? arr : []
    } catch (e) {
      return []
    }
  },

  saveManifest() {
    storage.set({
      key: MANIFEST_KEY,
      value: JSON.stringify(this._manifest),
      success: function() {},
      fail: function() {}
    })
  },

  list() {
    return this._manifest
  },

  // 判断是否存在同 id 条目（网络下载页重复下载判断用）
  hasEntry(id) {
    return this._manifest.some(function(x) { return x.id === id })
  },

  // 外部导入一条清单条目（网络下载页下载完成后调用）
  //  - 同 id 已存在时先删除旧条目及其文件（覆盖式导入）
  //  - 超过数量上限时删除最旧条目
  importEntry(entry, cb) {
    const that = this
    this.load(function(stored) {
      const old = stored.find(function(x) { return x.id === entry.id })
      if (old) {
        that.deleteSoundFiles(old)
      }
      const merged = stored.filter(function(x) { return x.id !== entry.id })
      merged.push(entry)
      while (merged.length > MAX_SOUNDS) {
        const removed = merged.shift()
        that.deleteSoundFiles(removed)
      }
      that._manifest = merged
      that.saveManifest()
      that.reportManifest()
      that.notify()
      cb && cb(true)
    })
  },

  getTransfers() {
    return this._transfers
  },

  // 是否存在进行中的同步传输（启动页据此在同步期间引导到自定义页查看置顶进度）
  hasActiveTransfer() {
    return Object.keys(this._transfers).length > 0
  },

  // 播放页配置（与 common/pages.js 的 cfg 结构兼容）
  getPlayConfig(id) {
    const that = this
    const m = this._manifest.find(function(x) { return x.id === id })
    if (!m || !m.files || m.files.length === 0) return null
    const cfg = {
      id: m.id,
      name: m.name,
      type: (m.mode === 'sequence') ? 'sequence' : 'single'
    }
    // 有封面用图片展示，无封面用文字展示
    if (m.imageName) {
      cfg.display = 'image'
      cfg.image = IMAGE_DIR + this.sanitizeFileName(m.imageName)
    } else {
      cfg.display = 'text'
      cfg.bgText = m.bgText || m.name
      cfg.centerText = m.centerText || m.name
    }
    if (cfg.type === 'single') {
      cfg.sound = AUDIO_DIR + this.sanitizeFileName(m.files[0].file)
      cfg.duration = m.duration || 1500
      // 单个音频冷却 = 时长 + 400ms（旧数据无 cooldown 时兜底）
      cfg.cooldown = m.cooldown || ((m.duration || 1500) + 400)
    } else {
      cfg.soundPath = AUDIO_DIR
      cfg.sounds = m.files.map(function(f) { return that.sanitizeFileName(f.file) })
      cfg.durations = m.files.map(function(f) { return f.duration || 1500 })
      // 多段音频：每个音频独立的冷却时间
      cfg.cooldowns = m.files.map(function(f) { return f.cooldown || ((f.duration || 1500) + 400) })
      cfg.totalSteps = m.totalSteps || m.files.length
    }
    return cfg
  },

  // 播放页配置（带内存缓存）：仅当内存清单确实包含目标 id 才走快路径，
  // 避免内存清单为空/过期（菜单异步 load 未完成等）时误判为"加载不出音效"；
  // 内存不含该 id 时一律重新从 storage 读取最新清单再查
  getPlayConfigCached(id, cb) {
    const that = this
    const done = function(cfg) { cb && cb(cfg) }
    if (Array.isArray(this._manifest) && this._manifest.some(function(x) { return x.id === id })) {
      done(this.getPlayConfig(id))
      return
    }
    this.load(function() {
      done(that.getPlayConfig(id))
    })
  },

  // ================= 播放 =================
  playById(id) {
    const m = this._manifest.find(function(x) { return x.id === id })
    if (!m || !m.files || m.files.length === 0) return
    audio.stop()
    audio.src = AUDIO_DIR + this.sanitizeFileName(m.files[0].file)
    audio.loop = false
    audio.play()
  },

  // ================= 删除 =================
  removeById(id) {
    const that = this
    const entry = this._manifest.find(function(x) { return x.id === id })
    if (!entry) return
    this._manifest = this._manifest.filter(function(x) { return x.id !== id })
    this.saveManifest()
    this.deleteSoundFiles(entry)
    this.reportManifest()
    this.notify()
  },

  deleteSoundFiles(entry) {
    const that = this
    if (entry.files) {
      entry.files.forEach(function(f) {
        that.deleteLocalFile(AUDIO_DIR + that.sanitizeFileName(f.file), function() {})
      })
    }
    if (entry.imageName) {
      that.deleteLocalFile(IMAGE_DIR + that.sanitizeFileName(entry.imageName), function() {})
    }
  },

  deleteLocalFile(uri, cb) {
    file.delete({
      uri: uri,
      success: function() { cb && cb(true) },
      fail: function() { cb && cb(false) }
    })
  },

  clearAll() {
    const that = this
    const entries = this._manifest.slice()
    this._manifest = []
    this.saveManifest()
    entries.forEach(function(e) {
      that.deleteSoundFiles(e)
    })
    this.reportManifest()
    this.notify()
  },

  // 上报清单给插件（便于插件侧管理/删除）
  reportManifest() {
    const connect = this.getConnect()
    if (!connect) return
    const sounds = this._manifest.map(function(m) {
      return {
        id: m.id,
        name: m.name,
        mode: m.mode,
        file: (m.files && m.files[0]) ? m.files[0].file : '',
        size: m.size
      }
    })
    try {
      connect.send({
        data: { type: 'audiosync', action: 'manifest', sounds: sounds },
        success: function() {},
        fail: function() {}
      })
    } catch (e) {
      console.error('上报清单失败', e)
    }
  },

  // ================= 连接状态 =================
  getReadyState(cb) {
    const connect = this.getConnect()
    if (!connect) {
      cb && cb(2)
      return
    }
    connect.getReadyState({
      success: function(data) {
        cb && cb(data.status)
      },
      fail: function() {
        cb && cb(2)
      }
    })
  },

  // ================= 工具 =================
  sanitizeFileName(name) {
    // 仅保留安全文件名，防止路径穿越
    return String(name || 'audio.mp3').replace(/[\\/:*?"<>|]/g, '_')
  },

  // 通知所有订阅者（事件驱动）。快照遍历 + 逐个 try/catch：
  // 单个订阅者抛异常不会中断传输流程，也不影响其他订阅者。
  notify() {
    const list = this._listeners
    if (!list || list.length === 0) return
    const snapshot = list.slice()
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i]()
      } catch (e) {}
    }
  }
}
