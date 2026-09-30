/**
 * 统一设置读写模块（内存缓存 + 落盘）
 *
 * 所有 storage 读取统一走本模块：
 *   - 首次读取从 storage 拉取并缓存到内存，之后直接命中缓存，避免重复 I/O
 *   - 写入时同步更新内存 + 落盘，保证内存永远是最新（缓存不失效）
 *   - getMany   批量并行读取，减少多次 storage 往返
 *   - setThrottled 节流写入（高频滚动位置等），合并为一次延迟落盘
 *   - remove    删除并同步清除缓存
 *   - clearCache 清空缓存（开发/调试用）
 *
 * 注意：
 *   - 模块级单例，所有页面共享同一份内存缓存
 *   - 任何「需要真实落盘后重读」的场景勿依赖缓存直读（可先 remove 再 get）
 */
import storage from '@system.storage'

// 内存缓存：key -> 已读值（原始字符串或 null）
const cache = {}
// 已加载 key 集合（区分「未读到」与「未加载」）
const loaded = {}

// 读取（Promise）：内存命中直接返回；否则读 storage 并缓存。
// def：key 未设置、值为空字符串或读取失败时返回的默认值（未提供则为 null）
// 注意：Vela storage.get 在 key 不存在时 success 回调返回空字符串 ''，统一将 '' 视为未设置
function get(key, def) {
  return new Promise((resolve) => {
    if (loaded[key]) {
      const v = cache[key]
      resolve(v !== undefined && v !== null && v !== '' ? v : (def !== undefined ? def : null))
      return
    }
    storage.get({
      key: key,
      success: (data) => {
        cache[key] = data
        loaded[key] = true
        resolve(data !== undefined && data !== null && data !== '' ? data : (def !== undefined ? def : null))
      },
      fail: () => {
        cache[key] = null
        loaded[key] = true
        resolve(def !== undefined ? def : null)
      }
    })
  })
}

// 写入：同步更新内存缓存 + 落盘
function set(key, value) {
  const str = String(value === undefined || value === null ? '' : value)
  cache[key] = str
  loaded[key] = true
  return new Promise((resolve) => {
    storage.set({
      key: key,
      value: str,
      success: () => resolve(str),
      fail: () => resolve(null)
    })
  })
}

// 批量并行读取（defaults 可省略，按需传入默认值数组）
function getMany(keys, defaults) {
  const arr = Array.isArray(keys) ? keys : [keys]
  return Promise.all(arr.map((k, i) => get(k, defaults && defaults[i])))
}

// 节流写入：高频调用时合并为一次延迟落盘（写最终值），降低 storage 写入频率
const throttleTimers = {}
const throttlePending = {}
function setThrottled(key, value, ms) {
  const delay = (ms && ms > 0) ? ms : 300
  const str = String(value === undefined || value === null ? '' : value)
  throttlePending[key] = str
  // 同步更新内存缓存，UI 立即可见
  cache[key] = str
  loaded[key] = true
  if (throttleTimers[key]) return
  throttleTimers[key] = setTimeout(() => {
    const v = throttlePending[key]
    delete throttlePending[key]
    delete throttleTimers[key]
    storage.set({ key: key, value: v, success: () => {}, fail: () => {} })
  }, delay)
}

// 删除：同步清除内存缓存 + 落盘删除
function remove(key) {
  delete cache[key]
  delete loaded[key]
  delete throttlePending[key]
  if (throttleTimers[key]) {
    clearTimeout(throttleTimers[key])
    delete throttleTimers[key]
  }
  return new Promise((resolve) => {
    storage.delete({ key: key, success: () => resolve(true), fail: () => resolve(false) })
  })
}

// 清空全部内存缓存（下次读取强制走 storage；调试用）
function clearCache() {
  Object.keys(loaded).forEach((k) => {
    delete loaded[k]
    delete cache[k]
  })
}

export default {
  get,
  set,
  getMany,
  setThrottled,
  remove,
  clearCache
}
