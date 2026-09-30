/**
 * 全局下载管理器（模块级单例）
 *
 * 下载队列/进度保存在模块作用域，不随页面销毁而丢失；
 * 由 app.ux 在 onCreate 中 init() 启动，实现「后台下载」——
 * 离开下载页后，系统级 request.download 继续执行，重新进入页面可恢复进度。
 *
 * 页面用法：
 *   import dlManager from '../../../../../common/downloadmanager'
 *   dlManager.enqueue(item)      // 空闲立即下载 / 下载中入队
 *   dlManager.remove(idx)        // 移除队列项
 *   dlManager.getState()         // { queue, current, currentId, percent, active, lastError }
 *   dlManager.isDownloading()    // 是否有下载进行（含队列非空）
 *   dlManager.onState(cb)        // 注册状态监听，返回注销函数（onHide/onDestroy 注销）
 */
import prompt from '@system.prompt'
import download from './download'

// 待下载队列容量上限
const QUEUE_MAX = 3

// 全局下载状态（模块级，页面销毁不影响）
const state = {
  queue: [],      // 待下载队列（最多3）
  current: '',    // 当前下载武器名
  currentId: '',  // 当前下载武器 id（用于识别「正在下载」的项，避免重复入队）
  percent: 0,     // 当前下载进度 0-100
  active: false,  // 是否有下载进行中
  lastError: '',  // 最近一次下载失败原因
  finishedCount: 0 // 已完成（成功/失败）的音效数量，供页面「每完成一个就刷新已下载标记」
}

// 页面注册的状态刷新回调
const listeners = []

function emit() {
  listeners.forEach((cb) => {
    try { cb(state) } catch (e) { console.error('[dlmgr] 状态监听异常', e) }
  })
}

export default {
  // 应用启动时调用（幂等）：确保全局下载管理器随 app 运行
  init() {
    // 模块加载即已就绪，此方法仅为 app.ux 显式启动入口（可扩展恢复未完成任务）
  },

  // 读取全局下载状态
  getState() {
    return state
  },

  // 是否正在下载（含队列非空）
  isDownloading() {
    return !!(state.active || state.current || state.queue.length > 0)
  },

  // 页面注册状态监听，返回注销函数（页面 onHide/onDestroy 时调用）
  onState(cb) {
    if (typeof cb !== 'function') return null
    const i = listeners.indexOf(cb)
    if (i < 0) listeners.push(cb)
    return () => {
      const j = listeners.indexOf(cb)
      if (j >= 0) listeners.splice(j, 1)
    }
  },

  // 加入下载队列：空闲立即开始；下载中则入队（同武器去重、上限3）
  // 返回值：'start' | 'queued' | 'downloading' | 'duplicate' | 'full'
  enqueue(item) {
    if (!item || !item.id) return 'invalid'
    // 正在下载的项不可重复入队（否则会在下载完成后再下载一遍）
    if (state.active && state.currentId && state.currentId === item.id) return 'downloading'
    if (state.active || state.current) {
      if (state.queue.some((x) => x.id === item.id)) return 'duplicate'
      if (state.queue.length >= QUEUE_MAX) return 'full'
      state.queue.push(item)
      emit()
      return 'queued'
    }
    this._start(item)
    return 'start'
  },

  // 从队列移除下载任务（下标）
  remove(idx) {
    if (idx >= 0 && idx < state.queue.length) {
      state.queue.splice(idx, 1)
      emit()
    }
  },

  // 启动一个武器的后台下载（系统级 request.download，页面退出后仍继续）
  _start(item) {
    state.active = true
    state.current = item.name
    state.currentId = item.id || ''
    state.percent = 0
    state.lastError = ''
    emit()
    download.downloadWeapon(item, {
      onProgress: (p) => {
        state.percent = Math.min(100, p)
        emit()
      },
      onComplete: () => {
        this._advance('下载完成：' + item.name, 1500)
      },
      onError: (msg) => {
        state.lastError = msg
        this._advance('下载失败：' + msg, 2000)
      }
    })
  },

  // 当前项下载结束（成功/失败）统一收尾：提示后推进队列。
  // 提示用 try/catch 保护，确保状态机一定向前推进——
  // 若此处抛异常导致 _next 不执行，active 会永久为 true，
  // 新任务只能入队而永不开始，且页面会因 active 为真但 current 为空而不显示进度条。
  _advance(message, duration) {
    try {
      prompt.showToast({ message: message, duration: duration })
    } catch (e) {
      console.error('[dlmgr] 提示异常', e)
    }
    this._next()
  },

  // 队列中有下一个则继续；否则结束下载。
  // 当前项字段与广播合并处理，避免出现 active=true 但 current 为空的中间态
  // （页面据此判定会误认为「无下载」而不显示进度条）。
  _next() {
    // 单项结束（成功/失败）：递增完成计数，页面据此「每完成一个音效就刷新已下载标记」
    state.finishedCount++
    if (state.queue.length > 0) {
      const next = state.queue.shift()
      this._start(next)
      return
    }
    state.active = false
    state.current = ''
    state.currentId = ''
    state.percent = 0
    emit()
  }
}
