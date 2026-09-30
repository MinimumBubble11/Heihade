/**
 * 统一播放页配置（内置音效唯一数据源）
 *
 * 每个音效对应一个配置项，key 为页面名（用于 /pages/play?name=xxx 跳转）
 *
 * 内置音效已精简为 5 个，其余音效由用户通过 GitHub 下载后从自定义列表播放。
 * 字段说明：
 *  - name      : 显示名称
 *  - type      : 'single' 单段 / 'sequence' 多段轮播 / 'cs' CS 包分组
 *  - display   : 'image' 封面 / 'text' 文字 / 'colortext' 彩色文字
 *  - image     : 封面图路径
 *  - sound     : 单段音效完整路径
 *  - soundPath : 多段音效目录
 *  - sounds    : 多段音效文件名数组
 *  - durations : 各音效时长（毫秒）
 *  - totalSteps: 总步数（进度条分母，> sounds.length 时重复靠前音频实现 Combo）
 */
export default {
  Shouqiang: {
    name: '手枪',
    type: 'sequence',
    image: '/common/images/封面/手枪.png',
    soundPath: '/common/sounds/手枪/',
    sounds: ['1.mp3', '2.mp3'],
    durations: [700, 1000],
    totalSteps: 4
  },

  Yaoyaolingxian: {
    name: '遥遥领先',
    type: 'sequence',
    display: 'colortext',
    image: '/common/images/封面/余华.png',
    centerText: '遥遥领先',
    textColors: ['#ff0000', '#FF8C00', '#00CC00', '#0088FF'],
    soundPath: '/common/sounds/遥遥领先/',
    sounds: ['1.mp3', '2.mp3'],
    durations: [1200, 1800],
    totalSteps: 4
  },

  Leijun: {
    name: '五字真言',
    type: 'sequence',
    image: '/common/images/封面/雷军.png',
    soundPath: '/common/sounds/雷军/',
    sounds: ['1.mp3', '2.mp3'],
    durations: 2000,
    totalSteps: 4
  },

  CSboom: {
    name: 'CS炸弹',
    type: 'cs',
    image: '/common/images/封面/CS包.png',
    soundPath: '/common/sounds/CS包/',
    sounds: ['1.mp3', '2.mp3', '3.mp3'],
    durations: [3000, 3200],
    totalSteps: 4
  },

  Jian: {
    name: '挥剑',
    type: 'single',
    image: '/common/images/封面/剑.png',
    sound: '/common/sounds/剑.mp3',
    duration: 1380,
    cooldown: 900
  }
}
