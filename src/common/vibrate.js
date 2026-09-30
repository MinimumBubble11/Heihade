/**
 * 震动设置共享模块
 *
 * 设置页可配置的震动模式，存储键为 vibration_mode：
 *   - 'off'   ：关闭震动
 *   - 'short' ：短震动
 *   - 'long'  ：长震动
 *
 * 兼容旧版布尔开关 vibration_enabled（'true'/'false'），读取时自动迁移。
 * 所有普通用户会点击的按钮，统一通过本模块按配置的模式触发震动。
 */
import vibrator from '@system.vibrator'
import settings from './settings'

export default {
  // 模式常量
  MODES: {
    OFF: 'off',
    SHORT: 'short',
    LONG: 'long'
  },

  // 默认模式
  DEFAULT_MODE: 'short',

  // 存储键
  KEY: 'vibration_mode',
  LEGACY_KEY: 'vibration_enabled',

  // 将任意输入归一化为合法模式（非法值回退到默认短震动）
  normalize(mode) {
    if (mode === this.MODES.OFF || mode === this.MODES.LONG) return mode
    return this.DEFAULT_MODE
  },

  // 读取当前震动模式（异步，兼容旧版开关；经 settings 内存缓存，避免重复 storage 读）
  getMode() {
    const that = this
    return settings.get(that.KEY).then(function(data) {
      if (data !== null && data !== undefined && data !== '') {
        return that.normalize(data)
      }
      // 旧版开关兼容：'false' → 关闭，其余 → 短震动
      return settings.get(that.LEGACY_KEY).then(function(legacy) {
        return (legacy === 'false' || legacy === false) ? that.MODES.OFF : that.DEFAULT_MODE
      })
    })
  },

  // 保存震动模式（同步旧版开关键，避免旧代码读到过期状态）
  setMode(mode) {
    const m = this.normalize(mode)
    settings.set(this.KEY, m)
    settings.set(this.LEGACY_KEY, String(m !== this.MODES.OFF))
  },

  // 页面加载用：返回 { enabled, mode }
  loadSetting() {
    const that = this
    return this.getMode().then(function(mode) {
      return {
        enabled: mode !== that.MODES.OFF,
        mode: mode
      }
    })
  },

  // 按配置的模式震动；mode 为 'off' 时静默
  vibrate(mode) {
    const m = this.normalize(mode)
    if (m === this.MODES.OFF) return
    vibrator.vibrate({ mode: m })
  }
}
