/**
 * dsh-nai-imagegen — browser half.
 *
 * Registers one sidebar icon and the panel page it opens: NovelAI credentials
 * and default sampling parameters on the left, a one-click test render and the
 * gallery of everything already rendered below.
 *
 * This is a hand-authored prebuilt bundle, matching the shape DSH's module
 * system consumes:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * Executing the bundle only registers that factory; the module body below runs
 * when the module is first materialized. `require` resolves the frozen platform
 * table (React) plus whatever `dsh.client.inject` declares. No JSX and no build
 * step: `React.createElement` covers a panel this size, and the file stays
 * readable as the artifact that actually ships.
 *
 * The token never reaches this half. Everything goes through the Host half's
 * loopback API, which is also the only place that can talk to NovelAI.
 */
window.__ModuleLoader__.load({
  id: 'dsh-nai-imagegen',
  factory(require) {
    // The module-system protocol: a factory builds its own module record, and
    // the loader caches whatever comes back from `exports`.
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'naiImagegen'
    /** Absolute path prefix of the Host half's API. */
    const API = '/nai-imagegen/api'
    /** Panel identity: the panellist row and the `main` entry share it. */
    const PANEL_ID = 'nai-imagegen'
    /** Relative cost the settings form warns above. */
    const HEAVY_UNITS = 4
    /**
     * Live controller for the transcript scanner. Off until the Host says the
     * `codeButtons` setting is on: the scanner walks every `<pre>` on each DOM
     * change, so leaving it running by default costs CPU in long sessions.
     */
    let setBlockButtons = () => {}
    let blockButtonsActive = false
    let blockButtonsDispose = null

    const zh = {
      panel: 'NovelAI 出图',
      title: 'NovelAI 出图',
      subtitle: '凭据与默认参数由宿主保管，出图只走本机回环接口。',
      credentials: '凭据',
      token: 'API Token',
      tokenPlaceholder: '填写 pst- 开头的 Persistent Token；留空表示不改动',
      tokenFromEnv: '当前生效的凭据来自环境变量 NAI_TOKEN，表单里的值会被它覆盖。',
      tokenNone: '尚未配置凭据，出图会直接失败。',
      tokenSet: '已配置凭据',
      baseUrl: '接口域名',
      proxy: '代理',
      proxyHint: '留空即直连（默认）。用中转站一般不需要代理；需要时填代理地址，例如 http://127.0.0.1:7890。',
      sideBaseUrlHint: '官方地址 https://image.novelai.net，或中转站地址。出图、查余额、导演工具都发到这个地址，Token 也会一起发给它。',
      sideProxyPlaceholder: '留空 = 直连',
      model: '模型',
      defaults: '默认参数',
      width: '宽',
      height: '高',
      steps: '步数',
      scale: '引导强度',
      sampler: '采样器',
      negative: '负面提示词',
      paths: '目录',
      outputDir: '出图目录',
      libraryDir: '索引目录',
      librarySourceDir: '库源目录',
      guard: '每次出图上限',
      keepImages: '最多保留张数',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      test: '试出一张',
      testing: '出图中…',
      probe: '检测连通性',
      probing: '检测中…',
      probeHint: '不消耗 Anlas：读订阅记录来验证主机、网络与凭据。',
      ucPreset: 'UC 预设',
      /**
       * 档位说明。**只描述分类，不断言两版内容相同** —— V4.5 与 V5 的分类体系一致
       * （0/1/2/3/4 对应同一组含义），但 `1 轻度排除` 那一档的正文两版不同
       * （V4.5 是 165 字符、V5 是 133 字符），furryFocus/humanFocus/heavy/none 才逐字相同。
       */
      ucPresetHint: '0 严格排除　1 轻度排除　2 兽人主体　3 人类主体　4 不使用',
      quality: '官方质量词',
      qualityOn: '质量词：开',
      qualityOff: '质量词：关',
      qualityHint:
        '开启后把官方那段 `very aesthetic, masterpiece, no text` 追加到正向末尾。默认关 —— 画师串里往往已有同类词，开启会重复叠加。',
      header: '头部插入',
      headerHint:
        '放到正向最开头（画师串之前）。用于 NovelAI 要求置顶的数据集标签：填 fur dataset 开 Furry Mode，填 background dataset 走背景数据集。留空则不插入。',
      artist: '画师串',
      artistCount: '已导入',
      artistCurrent: '当前',
      artistSearch: '搜索画师串名称或提示词…',
      artistNone: '不使用画师串',
      artistNonePicked: '已关闭画师串',
      artistPicked: '已切换画师串',
      artistMissing: '记住的画师串在当前索引里找不到了（索引可能被重建过）。请重新选一条。',
      keys: 'API Key 池',
      concurrency: '并发度',
      keyLabel: '标签',
      keyToken: '粘贴 pst- 开头的 Key（只写不回显）',
      keyAdd: '添加',
      keyVerify: '验证全部',
      keyEnable: '启用',
      keyDisable: '停用',
      keyRemove: '移除',
      autoOn: '自动出图：开',
      autoOff: '自动出图：关',
      autoHint: '开启后，正文里像提示词的代码块会自动出图。打开时只渲染最新那一个，之后新出现的自动出图，单次会话最多 12 张。会消耗额度。',
      codeButtonsOn: '代码块生图按钮：开',
      codeButtonsOff: '代码块生图按钮：关',
      codeButtonsHint:
        '在正文里每个像提示词的代码块下注入「🎨 生图」按钮。关闭时不再扫描 DOM（默认关，长会话下更省 CPU；自动出图依赖它，关闭后自动出图不会触发）。',
      copyImage: '复制图片',
      copyName: '复制文件名',
      copyPath: '复制完整路径',
      saveAs: '另存为…',
      studioTitle: '出图设置（按模式分开）',
      studioArtist: '画师串',
      studioNegative: '负面词',
      studioSave: '保存',
      studioSaved: '已保存',
      studioFailed: '失败',
      studioHint: '两个模式各存各的；留空的项沿用上方的公共默认。',
      studioChanged: '与公共默认不同（这个模式自己的设置）',
      studioRecipe: '漫画配方',
      testPrompt: '测试提示词',
      testPromptPlaceholder: '1girl, solo, standing, looking at viewer',
      variants: '张数',
      gallery: '图库',
      galleryEmpty: '还没有出图。',
      refresh: '刷新',
      loading: '载入中…',
      failed: '请求失败',
      heaviest: '当前参数相对消耗较高，会更快消耗额度。',
      inlineHint: '在对话里让 Agent 出图，图片会直接显示在正文中。',
      blockButton: '🎨 生图',
      blockWorking: '出图中…',
      blockDone: '已出图',
      blockFailed: '失败',
      libraries: '已索引的库',
      i2iTitle: '图生图',
      i2iSource: '底图',
      i2iRefresh: '刷新底图',
      i2iRun: '图生图',
      i2iRunning: '重绘中…',
      i2iSourceDir: '源目录',
      i2iNoSources: '源目录里没有图片：把 PNG/JPEG/WebP 放进去，再点「刷新底图」。',
      i2iPick: '选择底图',
      i2iPickChange: '更换底图',
      i2iRelease: '释放底图',
      i2iUpload: '从本地选择…',
      i2iUploading: '上传中…',
      i2iUploaded: '已上传到源目录并选中',
      i2iNoPick: '还没有选底图——点「选择底图」挑一张。',
      i2iPickerTitle: '选择底图',
      i2iPickerHint: '点击一张即选中并关闭；再选另一张时，上一张会被替换（同时只保留一个选择）。',
      i2iClose: '关闭',
      i2iHint:
        '提示词沿用上方「测试提示词」。宽高必须显式填写（默认取面板默认尺寸）；strength 越小越贴底图、越大重绘越多；一次 1 张，落在 Opus 免费区间时 0 Anlas（V5 仍会消耗用量）。',
      inpaintTitle: '局部重绘（inpaint）',
      inpaintHint:
        '在底图上涂出要重绘的区域（红色）；未涂区域保持原图。用 inpainting 模型（自动补 -inpainting 后缀），宽高沿用上面的设置；导出的蒙版 PNG 与输出同尺寸。',
      inpaintBrush: '笔刷大小',
      inpaintErase: '橡皮：关',
      inpaintEraseOn: '橡皮：开',
      inpaintClear: '清空蒙版',
      inpaintStrength: '重绘强度',
      inpaintRun: '局部重绘',
      inpaintRunning: '重绘中…',
      inpaintNoMask: '先在图上涂出要重绘的区域。',
      inpaintPick: '从图库选择…',
      inpaintPickChange: '更换图片',
      inpaintPickHint: '点击一张图：自动按它的长宽比取一个落在免费区间内的尺寸（竖图/横图/方图都能适配）。',
      loadMore: '加载更多',
      directorTitle: '导演工具（Director Tools）',
      directorHint: '对上方「从图库选择」的图片做后处理；这五个工具免费，不扣 Anlas。',
      directorTool: '工具',
      directorLineart: '线稿提取',
      directorSketch: '草图',
      directorColorize: '上色',
      directorEmotionTool: '表情微调',
      directorDeclutter: '杂物消除',
      directorEmotion: '表情',
      directorRun: '执行',
      directorRunning: '处理中…',
      directorUsing: '当前图片',
      sideTab: 'NovelAI',
      sideGuideTitle: 'NovelAI 出图',
      sideGuideDesc: '出图、改图、画师串与参考库，凭据和 Key 池也在这里',
      sideNavCreate: '出图',
      sideNavEdit: '改图',
      sideNavLibrary: '素材库',
      sideNavSettings: '设置',
      sideRender: '出图',
      sideTokenOk: '凭据就绪',
      sideTokenMissing: '未配置凭据',
      sideNoTokenPill: '未配置凭据 · 去设置',
      sideFree: 'Opus 免费区间',
      sideNotFree: '超出免费区间',
      sideNotFreeVariants: '多张会消耗 Anlas',
      sideExtras: '提示词附加',
      sideNoHeader: '无头部插入',
      sideSampling: '画幅与采样',
      sidePortrait: '竖',
      sideLandscape: '横',
      sideSquare: '方',
      sideModes: '按模式覆盖',
      sideModesSum: '出图 / 漫画',
      sideOpenStudio: '打开模式设置',
      sideLatest: '最近作品',
      sideGalleryEmpty: '还没有出图。写好提示词，按「出图」或 Ctrl+Enter。',
      sideEditThis: '改这张',
      sideInpaint: '局部重绘',
      sideDirector: '导演工具',
      sideSharedPrompt: '提示词（与「出图」共用）',
      sideI2iHint: 'strength 越小越贴底图。宽高必须写明；单张且在免费区间内不消耗 Anlas。',
      sideNoRenderPicked: '从图库选一张作品，或在「出图」里点作品上的「改这张」。',
      sideInpaintHint: '在图上涂出要重绘的区域，没涂的部分保持原样。尺寸按原图比例自动取免费区间内的值。',
      sideCanvas: '画布',
      sideBooks: '参考库',
      sideAllLibs: '全部',
      sideLookup: '全文检索',
      sideResolve: '角色名册',
      sideLookupPh: '中文词、标签或条目名，例如 双马尾',
      sideResolvePh: '角色名，例如 初音未来',
      sideLookupHint: '在已索引的库里按标题、触发词和正文检索，返回原文。a/b/c 表示多选一，[x] 是要替换的占位符。',
      sideResolveHint: '在同人库名册里查角色的官方 Danbooru 标签和外观要点。',
      sideSearch: '检索',
      sideSearching: '检索中…',
      sideHits: '命中',
      sideNoHits: '没有命中。',
      sideExpand: '展开',
      sideCollapse: '收起',
      sideCopy: '复制原文',
      sideCopied: '已复制到剪贴板',
      sideInsertTag: '插入标签',
      sideInserted: '已追加到提示词',
      sideLibEmpty: '还没有索引任何库。在下方「索引」里填好世界书 JSON 所在目录，再点「重建索引」。',
      sideIndexCard: '索引',
      sideNotIndexed: '未建索引',
      sideIndexHint: '从世界书 JSON（文件名含「附体」）重建五个库的索引。同一个库有多个版本时，条目最多的那个胜出。',
      sideReindex: '重建索引',
      sideReindexing: '重建中…',
      libReindexed: '已重建',
      libReindexNone: '源目录里没有找到可索引的附体库 JSON。',
      sideArtistEmpty: '还没有导入画师串。在插件目录里运行下面的命令，导入后点「刷新」。',
      sideArtistPerMode: '按模式分别选',
      sideConnection: '连接',
      sideProxyDetected: '已检测到系统代理',
      sideProbeOk: '连通正常',
      sideProbeFail: '连接失败',
      sideStepsLeft: '剩余训练步数',
      sideKeysHint: '每把可用的 Key 提供一路并发。401/403 自动停用，429 与 5xx 冷却后换 Key 继续。',
      sideUnnamedKey: '未命名',
      sideChat: '对话集成',
      sideCodeBtn: '代码块「🎨 生图」按钮',
      sideAuto: '自动出图',
      sideCodeBtnShort: '按钮',
      sideAutoShort: '自动',
      sideOn: '开',
      sideOff: '关',
      sideDirs: '目录与限额',
      sideSourceDir: '图生图底图目录',
      sideDirsHint: '出图目录也是正文内联图片的来源。底图目录留空时，取出图目录旁的 _in/nai。',
      sideHealth: '自检',
      sideHealthIdle: '未运行',
      sideHealthOk: '全部通过',
      sideHealthFail: '项未通过',
      sideHealthRun: '运行自检',
      sideHealthRunning: '检查中…',
      sideHealthHint: '逐项检查配置、Key 池、代理、画师串、五个库和浏览器端，不出图，不消耗额度。',
      sideUnsaved: '有未保存的修改',
      sideDiscard: '放弃',
      sideNeedsRestart: '宿主端还是旧版本，需要重启 DSH 才能用这个功能。',
      uc0: '严格排除',
      uc1: '轻度排除',
      uc2: '兽人主体',
      uc3: '人类主体',
      uc4: '不使用',
      sideStyle: '画师串',
      sideStyleNone: '未使用画师串',
      sideStyleNoneHint: '出图只用提示词本身。从下面挑一个画风，会加在每次出图和改图的提示词前面。',
      sideStyleChange: '更换',
      sideStyleChoose: '选画风',
      sideStyleClose: '收起',
      sideStyleRemove: '不用',
      sideStyleAll: '全部',
      sideStyleSearch: '搜索名称或提示词…',
      sideStyleEmpty: '没有匹配的画师串。',
      sideStylePreview: '看大图预览',
      sideCharPreview: '看大图预览',
      sideCharRefNone: '还没有参考图',
      sideViewerKindCharacter: '角色参考图',
      sideViewerKindArtist: '画师串预览',
      sideViewerZoom: '放大 / 缩小',
      sideStyleTotal: '条画师串',
      sideStyleOff: '不使用',
      sideStylePerMode: '漫画单独设置',
      sideStyleApplies: '对出图、图生图和局部重绘生效',
      sideAddFromLib: '从角色库添加',
      sideAddRow: '角色',
      sideArtCopy: '副本',
      sideArtCover: '用最新作品当封面',
      sideArtCoverDone: '封面已换成这张图',
      sideArtCoverHint: '把最近作品的第一张设为这条画师串的预览图，文字不变',
      sideArtCreated: '已另存为新画师串',
      sideArtDelete: '删除这条',
      sideArtDeleted: '已删除这条画师串',
      sideArtDiscard: '放弃改动',
      sideArtEdited: '已修改',
      sideArtMine: '我的',
      sideArtName: '名称',
      sideArtNegative: '负面',
      sideArtNone: '还没有选画师串',
      sideArtOverrideBadge: '本次改过',
      sideArtOverrideOn: '画师串文字本次改过',
      sideArtPositive: '正面',
      sideArtRevert: '恢复原文',
      sideArtReverted: '已恢复画师串原文',
      sideArtSave: '保存到这条',
      sideArtSaveNew: '另存为新的',
      sideArtSaved: '已保存到这条画师串',
      sideArtText: '文字',
      sideArtTextHint: '这里的改动只用于接下来的出图；想一直用就保存。原始画师串文件不会被改动。',
      sideAttachHint: '也可以直接把图片拖进来或粘贴',
      sideAttachImage: '附参考图',
      sideAttempts: '重试',
      sideCallSize: '本次尺寸',
      sideCallSizeHint: '模型建议的尺寸，只用于接下来的出图；点一下改回默认尺寸',
      sideCancel: '取消',
      sideCaption: '当前提示词',
      sideCharCase: '区分大小写',
      sideCharAiDone: '已按提示词改写，检查后保存',
      sideCharAiEdit: '用提示词改特征',
      sideCharAiEmpty: '先写一句要怎么改',
      sideCharAiHint: '上面的提示词模型会按这一句话重写固定特征和可选服装；结果只填进表单，确认后再保存。',
      sideCharAiPh: '例如：把发色改成银白色，加一副黑色蕾丝眼罩，去掉兽耳',
      sideCharAiRun: '让模型改写',
      sideCharAiRunning: '改写中…',
      sideCharDna: '固定特征（DNA）',
      sideCharDnaHint: '每张图都不变的外貌：角色标签、发型发色、瞳色、体型、种族特征、标志性饰品。衣服、动作和表情不要写在这里。',
      sideCharEdit: '编辑角色',
      sideCharEditShort: '编辑',
      sideCharEmpty: '还没有角色。新建一个，或者从图片生成。',
      sideCharGroup: '分组',
      sideCharHowTo: '写提示词时，自然语言里出现角色关键字，这个角色的 DNA 就会交给模型；点「本次使用」也会带上。勾选「替换角色关键字」后，出图时提示词里的关键字会换成固定特征。',
      sideCharImported: '已导入角色',
      sideCharKeywords: '关键字',
      sideCharKeywordsHint: '逗号分隔；也可以写正则，例如 /hatsune\\s*miku/i',
      sideCharName: '名称',
      sideCharNameNeeded: '请填写角色名称',
      sideCharNegative: '不要出现',
      sideCharNew: '新建角色',
      sideCharNoDna: '（未填写固定特征）',
      sideCharOwnRules: '单独设置匹配规则',
      sideCharPick: '本次使用',
      sideCharPickHint: '不靠关键字匹配，直接把这个角色交给写提示词',
      sideCharSaved: '角色已保存',
      sideCharSearch: '搜索角色、关键字或特征',
      sideCharToRow: '加入提示词',
      sideCharTok: '角色',
      sideCharUnpick: '取消使用',
      sideCharVarAdd: '可选特征',
      sideCharVarName: '条目名，如 校服',
      sideCharVarPrompt: '标签',
      sideCharVariable: '可选特征（服装、造型等）',
      sideCharWhole: '全词匹配',
      sideChars: '角色',
      sideCharsShort: '角色',
      sideClear: '清空',
      sideConfirmDelete: '再点一次确认',
      sideDnaChange: '点击换一张，或拖入、粘贴图片',
      sideDnaDone: '已生成角色草稿，检查后保存',
      sideDnaDraft: '草稿',
      sideDnaDrop: '点击选择图片，或拖入、粘贴',
      sideDnaFromImage: '从图片生成 DNA',
      sideDnaHelp: '模型看图写出角色的固定特征和图里的服装。结果先放进编辑表单，不会直接保存。',
      sideDnaHintPh: '补充说明（可选），例如：这是我的原创角色「小雪」，耳朵是狐耳',
      sideDnaNoImage: '先选一张图',
      sideDecode: '解码',
      sideDecodeHint: '默认 json：和 nai-dbgen 的「自动」同一条 base64 信封路径，体积约大三分之一；zip 体积最小；auto 发 */*，按返回内容解码。',
      sideDecodeJson: 'json（base64，默认）',
      sideDecodeZip: 'zip（体积最小）',
      sideDecodeAuto: 'auto（跟随响应）',
      sideDnaRun: '生成 DNA',
      sideDnaRunning: '识别中…',
      sideEditWithChars: '「当前提示词」里的角色也会一起发送：',
      sideExport: '导出',
      sideGroupActive: '启用',
      sideGroupActiveHint: '关闭的分组不参与关键字匹配和替换',
      sideGroupDelete: '删除分组和其中的角色',
      sideGroupName: '分组名称',
      sideGroupNew: '分组',
      sideGroupRename: '重命名',
      sideImageBig: '图片超过 8MB，请换一张小一点的',
      sideImageType: '只支持 PNG、JPEG、WebP 或 GIF 图片',
      sideImport: '导入',
      sideJsonBad: '文件不是有效的 JSON',
      sideLlm: '提示词模型',
      sideLlmDefault: '跟随 DSH 默认模型',
      sideLlmFollow: '跟随 DSH 默认模型',
      sideLlmMaxTokens: '单次输出上限',
      sideLlmOff: '写提示词不可用',
      sideLlmOffShort: '不可用',
      sideLlmPinned: '插件指定',
      sideLlmPending: '还没保存，点底部「保存」后改用：',
      sideLlmRetries: '格式不对时重试',
      sideLlmRoute: '使用的模型',
      sideLlmRouteHint: '列表来自 DSH 的模型设置。反推和从图片生成 DNA 需要支持图片的模型（标 👁）。',
      sideLlmVisionNo: '不支持图片',
      sideLlmVisionUnknown: '不确定是否支持图片',
      sideLlmVisionYes: '支持图片',
      sideMarket: '标签超市',
      sideMarketEmpty: '还没有导入标签超市。导入一份分好类的标签 JSON 后，点标签就能插进提示词里光标所在的位置。',
      sideMarketHint: '点标签会插到最后点过的提示词框的光标处；再点一次把它取出来。',
      sideMarketImported: '已导入标签',
      sideMarketNone: '未导入',
      sideMarketSearch: '搜索标签名称或内容',
      sideMarketTags: '个标签',
      sideMoveDown: '下移',
      sideMoveUp: '上移',
      sideNegative: '负面',
      sideNoAnalysis: '模型没有写分析。',
      sideNoiseSchedule: '噪声计划',
      sideNoiseV5: 'V5 固定使用 karras',
      sidePickRefs: '挑参考条目',
      sideAddChar: '添加角色',
      sideAddCharBlank: '空白角色（手填）',
      sideCharTagHint: '点一下展开 / 收起这个角色的提示词',
      sidePosAuto: '自动',
      sidePosition: '位置',
      sidePositionHint: '在 5×5 网格上选角色的位置；再点一次已选的格子就改回自动。方向键移动，Delete 清除。',
      sidePositive: '正面',
      sidePresetDiscard: '放弃修改',
      sidePresetDna: '图片生成 DNA',
      sidePresetDnaHint: '可用变量：{{补充说明}}。模型必须只返回一个 JSON 对象。',
      sidePresetReset: '恢复默认',
      sidePresetSystem: '系统提示',
      sidePresetUser: '用户消息',
      sidePresetWrite: '写提示词',
      sidePresetWriteHint: '可用变量：{{用户描述}} {{角色库}} {{参考条目}} {{画面尺寸}}。输出必须是 scene / scene_uc / char / char_uc 这些字段。',
      sidePresets: '提示词预设',
      sidePresetsSum: '写提示词 · 图片生成 DNA',
      sideRefImage: '参考图',
      sideRefPick: '本次参考',
      sideRefPickHint: '写提示词时把这条原文一起交给模型',
      sideRefToI2i: '拿这张做图生图',
      sideRefUnpick: '取消参考',
      sideRemove: '移除',
      sideReplaceKw: '替换角色关键字',
      sideReplaceKwHint: '出图时把提示词里的角色关键字换成该角色的固定特征',
      sideReplaceKwOn: '关键字会换成 DNA',
      sideReverse: '反推',
      sideReverseDone: '已按参考图写好提示词，检查后出图',
      sideReverseHint: '用参考图和自然语言写成下面的提示词，不会自动出图',
      sideReverseResult: '反推结果',
      sideRowName: '备注名（不发送）',
      sideRowPlaceholder: '这个角色的标签',
      sideScenePlaceholder: '场景、构图、人数等，例如 2girls, classroom, sunset',
      sideSeed: '种子',
      sideSeedRandom: '随机种子',
      sideSeedReuse: '沿用上次种子',
      sideVarietyHint: 'V4.5 的 Variety+：画面变化更大，构图更少重复',
      sideAnlas: '点数',
      sideBalance: '余额',
      sideBalanceHint: '用凭证读取剩余点数（Anlas）和 V5 电量，不出图、不消耗点数。',
      sideBalanceRefresh: '刷新余额',
      sideCharRef: '参考图',
      sideCharRefArtist: '用当前画师串',
      sideCharRefDone: '参考图已生成，并设为这个角色的封面',
      sideCharRefGen: '生成参考图',
      sideCharRefHint: '用这个角色的固定特征（可加一套可选特征）出一张单人全身立绘，存进最近作品，并设为角色封面。',
      sideCharRefLatest: '用最新作品',
      sideCharRefRemove: '移除参考图',
      sideCharRefRunning: '生成中',
      sideCharRefVariantNone: '只用固定特征',
      sideConfirmDeleteAll: '再点一次，全部删除',
      sideDeleteAll: '全部删除',
      sideDeleteRender: '删除',
      sideDeleteSelected: '删除所选',
      sideDeleted: '已删除',
      sideEnergy: '电量',
      sideEnergyEmpty: '电量已用完',
      sideEnergyFull: '已满',
      sideEnergyRefill: '后 +1%',
      sideGalleryCount: '张',
      sideGalleryEmptyAll: '还没有作品。',
      sideGalleryHint: '作品保存在输出目录里，图和记录文件一起删除。「只保留最新」会删掉更早的作品；「保留张数上限」是出图后自动清理的数量（0 = 不清理）。',
      sideGalleryManage: '整理作品库',
      sideInsertChar: '角色',
      sideInsertCharHint: '把角色关键字写进描述，写提示词时模型会拿到这个角色的 DNA',
      sideModelCustom: '自定义…',
      sideModelHint: 'Curated 只用精选数据训练，画面更稳；Full 题材更广。V5 Curated 没有对应的重绘模型，局部重绘会改用 V5 Full。',
      sideNavGallery: '作品',
      sideRenderCancelled: '已取消出图',
      sideRenderReceived: '已收到',
      sideRenderSlow: '还没有结果多半是中转站回传图片慢：可以继续等，或取消后重试',
      sideRenderWaiting: '正在出图',
      sideSelect: '选择',
      sideSelectAll: '全选',
      sideTrimKeep: '只保留最新',
      sideLog: '日志',
      sideLogItems: '条',
      sideLogErrors: '条出错',
      sideLogHint: '记录写提示词、图片生成 DNA、出图等每一次调用，用来排查问题。Token、图片内容不会写进日志；保留 14 天。',
      sideLogAll: '全部',
      sideLogWrite: '写提示词',
      sideLogRender: '出图',
      sideLogDna: '图片 DNA',
      sideLogCharacter: '角色改写',
      sideLogErrorsOnly: '只看有问题的',
      sideLogEmpty: '还没有日志记录。',
      sideLogDownload: '下载今天的日志',
      sideLogClear: '清空日志',
      sideLogCleared: '已清空日志',
      sideLogOpen: '查看日志',
      sideLogDir: '日志目录',
      sideLogEvent_write: '写提示词',
      sideLogEvent_dna: '图片 DNA',
      sideLogEvent_render: '出图',
      sideLogEvent_director: '导演工具',
      sideLogEvent_probe: '检测连通性',
      sideLogEvent_balance: '余额',
      sideLogEvent_character: '角色改写',
      sideLogEvent_error: '错误',
      sideLogEvent_log: '日志',
      sideWriteRefused: '模型拒绝了这次请求（内容审核）',
      sideWriteInvalid: '模型没有按格式返回提示词',
      sideWriteRaw: '模型原始回复',
      sideWriteAttempts: '共尝试 {n} 次',
      sideBooksEmptyHint: '参考库还没有建立索引，所以素材库里先隐藏了它。把世界书 JSON（文件名含 标签库 / 常规模板 / 扩展库 / 同人库 / SEX模板）放进下面的「库源目录」，再点「重建索引」，参考库就会出现。',
      sideTransparent: '透明底',
      sideTransparentHint: '生成带透明通道的图片（只有 V5 支持）。点一下立即生效。',
      sideTransparentV5: '透明底只有 V5 模型支持。',
      sideTransparentOffHint: '当前出的是透明底图片，点一下关闭',
      sideSmeaHint: 'SMEA 只对 V3 模型有效；V4 以后的模型没有这个选项。',
      sideViewer: '查看作品',
      sideViewerCopy: '复制提示词',
      sideViewerCover: '设为画师串封面',
      sideViewerDownload: '下载',
      sideViewerLoad: '载入工作台',
      sideViewerLoaded: '已把这张图的提示词载入工作台',
      sideViewerNext: '下一张',
      sideViewerNoMeta: '这张图没有记录',
      sideViewerPrev: '上一张',
      sideVisionOff: '当前模型没有声明图片输入，参考图不会发给它。请在「设置 → 提示词模型」里换一个标 👁 的模型。',
      sideWrite: '写提示词',
      sideWriteCancelled: '已取消写提示词',
      sideWriteDone: '提示词已写好，检查后出图',
      sideWriteEmpty: '写一句想要的画面，或者附一张参考图',
      sideWriteHint: '用 DSH 里配置的模型把描述写成下面的结构化提示词，不会自动出图（Ctrl+Enter）',
      sideWriteModel: '写提示词使用的模型',
      sideWritePlaceholder: '用自然语言描述想要的画面，例如：初音未来坐在雨后的天台上，背后是黄昏的城市。可以粘贴或拖入参考图。',
      sideWriteResult: '写提示词结果',
      sideWriteTitle: '描述画面',
      sideWriting: '写作中…'
    }
    const en = {
      panel: 'NovelAI images',
      title: 'NovelAI images',
      subtitle: 'The host holds the credential and the defaults; rendering only goes through the loopback API.',
      credentials: 'Credential',
      token: 'API token',
      tokenPlaceholder: 'A pst-… persistent token; leaving it blank keeps the stored one',
      tokenFromEnv: 'The effective credential comes from the NAI_TOKEN environment variable and overrides this field.',
      tokenNone: 'No credential configured yet — rendering will fail.',
      tokenSet: 'Credential configured',
      baseUrl: 'API base',
      proxy: 'Proxy',
      proxyHint: 'Blank connects directly (default). A relay usually needs no proxy; otherwise enter a proxy URL such as http://127.0.0.1:7890.',
      sideBaseUrlHint: 'The official https://image.novelai.net or a relay address. Renders, balance and Director tools all go there, and so does the token.',
      sideProxyPlaceholder: 'blank = direct',
      model: 'Model',
      defaults: 'Defaults',
      width: 'Width',
      height: 'Height',
      steps: 'Steps',
      scale: 'Guidance',
      sampler: 'Sampler',
      negative: 'Negative prompt',
      paths: 'Directories',
      outputDir: 'Output',
      libraryDir: 'Index',
      librarySourceDir: 'Library source',
      guard: 'Variants per call',
      keepImages: 'Keep at most',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      test: 'Render a test',
      testing: 'Rendering…',
      probe: 'Check connectivity',
      probing: 'Checking…',
      probeHint: 'Spends no Anlas: reads the subscription record to verify host, network and credential.',
      ucPreset: 'UC preset',
      ucPresetHint: '0 heavy　1 light　2 furryFocus　3 humanFocus　4 none',
      quality: 'Official quality tags',
      qualityOn: 'Quality tags: on',
      qualityOff: 'Quality tags: off',
      qualityHint:
        'Appends the official `very aesthetic, masterpiece, no text` to the end of the positive prompt. Off by default — artist strings often already carry the same words.',
      header: 'Header',
      headerHint:
        'Inserted at the very start of the positive prompt, ahead of the artist string. Use it for NovelAI dataset tags that must come first: `fur dataset` enables Furry Mode, `background dataset` switches to scenery. Leave empty for none.',
      artist: 'Artist string',
      artistCount: 'Imported',
      artistCurrent: 'Current',
      artistSearch: 'Search artist names or prompts…',
      artistNone: 'No artist string',
      artistNonePicked: 'Artist string cleared',
      artistPicked: 'Artist string set',
      artistMissing: 'The remembered artist string is not in the current index (it may have been rebuilt). Pick one again.',
      keys: 'API key pool',
      concurrency: 'Concurrency',
      keyLabel: 'Label',
      keyToken: 'Paste a pst-… key (write-only)',
      keyAdd: 'Add',
      keyVerify: 'Verify all',
      keyEnable: 'Enable',
      keyDisable: 'Disable',
      keyRemove: 'Remove',
      autoOn: 'Auto-render: on',
      autoOff: 'Auto-render: off',
      autoHint: 'When on, prompt-looking code blocks render by themselves. Turning it on renders only the newest one; new blocks follow. Capped at 12 per session. It spends quota.',
      codeButtonsOn: 'Code-block button: on',
      codeButtonsOff: 'Code-block button: off',
      codeButtonsHint:
        'Injects the "🎨 Render" button under prompt-looking code blocks. Off stops the transcript scan entirely (default off; cheaper on long sessions). Auto-render depends on it, so it cannot fire while this is off.',
      copyImage: 'Copy image',
      copyName: 'Copy file name',
      copyPath: 'Copy full path',
      saveAs: 'Save as…',
      studioTitle: 'Render settings (per mode)',
      studioArtist: 'Artist',
      studioNegative: 'Negative',
      studioSave: 'Save',
      studioSaved: 'Saved',
      studioFailed: 'Failed',
      studioHint: 'Each mode keeps its own; an empty field falls back to the shared default.',
      studioChanged: 'Differs from the shared default (this mode owns it)',
      studioRecipe: 'Comic recipe',
      testPrompt: 'Test prompt',
      testPromptPlaceholder: '1girl, solo, standing, looking at viewer',
      variants: 'Variants',
      gallery: 'Gallery',
      galleryEmpty: 'Nothing rendered yet.',
      refresh: 'Refresh',
      loading: 'Loading…',
      failed: 'Request failed',
      heaviest: 'These settings are comparatively heavy on quota.',
      inlineHint: 'Ask the Agent to render in chat and the image appears inline in the reply.',
      blockButton: '🎨 Render',
      blockWorking: 'Rendering…',
      blockDone: 'Rendered',
      blockFailed: 'Failed',
      libraries: 'Indexed libraries',
      i2iTitle: 'Image-to-image',
      i2iSource: 'Base image',
      i2iRefresh: 'Refresh sources',
      i2iRun: 'Render img2img',
      i2iRunning: 'Reworking…',
      i2iSourceDir: 'Source dir',
      i2iNoSources: 'No images in the source directory — drop PNG/JPEG/WebP in, then click "Refresh sources".',
      i2iPick: 'Choose base image',
      i2iPickChange: 'Change base image',
      i2iRelease: 'Release base image',
      i2iUpload: 'Choose from disk…',
      i2iUploading: 'Uploading…',
      i2iUploaded: 'Uploaded to the source directory and selected',
      i2iNoPick: 'No base image selected — click "Choose base image" and pick one.',
      i2iPickerTitle: 'Choose a base image',
      i2iPickerHint: 'Click a thumbnail to select it and close the picker; picking another replaces the previous choice (only one is held).',
      i2iClose: 'Close',
      i2iHint:
        'The prompt comes from the test prompt above. Width and height are required (defaults come from the panel defaults); a lower strength stays closer to the base image, a higher one reinterprets more. One image per call; inside the Opus free band it costs 0 Anlas (V5 still draws usage).',
      inpaintTitle: 'Inpaint (masked redraw)',
      inpaintHint:
        'Paint the region to redraw (red) over the base image; everything unpainted is kept. Uses an inpainting model (the -inpainting suffix is appended automatically); width and height follow the settings above, and the exported mask PNG matches the output size.',
      inpaintBrush: 'Brush size',
      inpaintErase: 'Eraser: off',
      inpaintEraseOn: 'Eraser: on',
      inpaintClear: 'Clear mask',
      inpaintStrength: 'Redraw strength',
      inpaintRun: 'Inpaint',
      inpaintRunning: 'Repainting…',
      inpaintNoMask: 'Paint the region to redraw first.',
      inpaintPick: 'Choose from gallery…',
      inpaintPickChange: 'Change image',
      inpaintPickHint: 'Click an image: its aspect ratio is used to pick a size that stays inside the free band (portrait, landscape and square all fit).',
      loadMore: 'Load more',
      directorTitle: 'Director Tools',
      directorHint: 'Post-process the image chosen above with "Choose from gallery"; all five tools are free (no Anlas).',
      directorTool: 'Tool',
      directorLineart: 'Line art',
      directorSketch: 'Sketch',
      directorColorize: 'Colorize',
      directorEmotionTool: 'Change emotion',
      directorDeclutter: 'Declutter',
      directorEmotion: 'Emotion',
      directorRun: 'Run',
      directorRunning: 'Working…',
      directorUsing: 'Image',
      sideTab: 'NovelAI',
      sideGuideTitle: 'NovelAI Render',
      sideGuideDesc: 'Render, edit, artist strings and reference libraries; credentials and keys too',
      sideNavCreate: 'Create',
      sideNavEdit: 'Edit',
      sideNavLibrary: 'Library',
      sideNavSettings: 'Settings',
      sideRender: 'Render',
      sideTokenOk: 'Credential ready',
      sideTokenMissing: 'No credential',
      sideNoTokenPill: 'No credential · open settings',
      sideFree: 'Opus free band',
      sideNotFree: 'Outside the free band',
      sideNotFreeVariants: 'Several images cost Anlas',
      sideExtras: 'Prompt extras',
      sideNoHeader: 'no header',
      sideSampling: 'Size and sampling',
      sidePortrait: 'Portrait',
      sideLandscape: 'Landscape',
      sideSquare: 'Square',
      sideModes: 'Per-mode overrides',
      sideModesSum: 'illustration / comic',
      sideOpenStudio: 'Open mode settings',
      sideLatest: 'Recent',
      sideGalleryEmpty: 'Nothing rendered yet. Write a prompt and press Render or Ctrl+Enter.',
      sideEditThis: 'Edit',
      sideInpaint: 'Inpaint',
      sideDirector: 'Director',
      sideSharedPrompt: 'Prompt (shared with Create)',
      sideI2iHint: 'A lower strength stays closer to the base. Width and height are required; one image inside the free band costs no Anlas.',
      sideNoRenderPicked: 'Pick a render from the gallery, or use "Edit" on an image in Create.',
      sideInpaintHint: 'Paint the region to redraw; everything else is kept. The size follows the image ratio inside the free band.',
      sideCanvas: 'Canvas',
      sideBooks: 'References',
      sideAllLibs: 'All',
      sideLookup: 'Full text',
      sideResolve: 'Characters',
      sideLookupPh: 'A word, tag or entry title, e.g. twintails',
      sideResolvePh: 'A character name, e.g. hatsune miku',
      sideLookupHint: 'Searches titles, trigger keys and bodies of the indexed libraries and returns the original text. a/b/c means pick one; [x] is a placeholder to replace.',
      sideResolveHint: 'Looks up a character’s official Danbooru tag and appearance anchors in the roster.',
      sideSearch: 'Search',
      sideSearching: 'Searching…',
      sideHits: 'Hits',
      sideNoHits: 'No hits.',
      sideExpand: 'Expand',
      sideCollapse: 'Collapse',
      sideCopy: 'Copy text',
      sideCopied: 'Copied to the clipboard',
      sideInsertTag: 'Insert tag',
      sideInserted: 'Appended to the prompt',
      sideLibEmpty: 'No library is indexed yet. Set the world-book JSON folder under Index below, then press Rebuild index.',
      sideIndexCard: 'Index',
      sideNotIndexed: 'not indexed',
      sideIndexHint: 'Rebuilds the five library indexes from world-book JSONs whose names contain 附体. When a library has several releases, the one with the most entries wins.',
      sideReindex: 'Rebuild index',
      sideReindexing: 'Rebuilding…',
      libReindexed: 'Rebuilt',
      libReindexNone: 'No indexable library JSON was found in the source folder.',
      sideArtistEmpty: 'No artist strings imported yet. Run this in the plugin folder, then press Refresh.',
      sideArtistPerMode: 'Choose per mode',
      sideConnection: 'Connection',
      sideProxyDetected: 'System proxy detected',
      sideProbeOk: 'Connected',
      sideProbeFail: 'Connection failed',
      sideStepsLeft: 'training steps left',
      sideKeysHint: 'Each usable key is one concurrent render. 401/403 disables a key; 429 and 5xx cool it down and move on to another.',
      sideUnnamedKey: 'Unnamed',
      sideChat: 'Chat integration',
      sideCodeBtn: 'Code-block "🎨 Render" button',
      sideAuto: 'Auto-render',
      sideCodeBtnShort: 'button',
      sideAutoShort: 'auto',
      sideOn: 'on',
      sideOff: 'off',
      sideDirs: 'Folders and limits',
      sideSourceDir: 'img2img base folder',
      sideDirsHint: 'The output folder is also where inline chat images come from. A blank base folder means _in/nai next to the output folder.',
      sideHealth: 'Health check',
      sideHealthIdle: 'not run',
      sideHealthOk: 'all passed',
      sideHealthFail: 'failed',
      sideHealthRun: 'Run health check',
      sideHealthRunning: 'Checking…',
      sideHealthHint: 'Checks config, key pool, proxy, artist strings, the five libraries and the browser half. Renders nothing and spends nothing.',
      sideUnsaved: 'Unsaved changes',
      sideDiscard: 'Discard',
      sideNeedsRestart: 'The host half is still the older version; restart DSH to use this.',
      uc0: 'Heavy',
      uc1: 'Light',
      uc2: 'Furry focus',
      uc3: 'Human focus',
      uc4: 'None',
      sideStyle: 'Artist string',
      sideStyleNone: 'No artist string',
      sideStyleNoneHint: 'Renders use the prompt alone. Pick a style below and it is prepended to every render and edit.',
      sideStyleChange: 'Change',
      sideStyleChoose: 'Pick a style',
      sideStyleClose: 'Close',
      sideStyleRemove: 'Clear',
      sideStyleAll: 'All',
      sideStyleSearch: 'Search names or prompts…',
      sideStyleEmpty: 'No artist string matches.',
      sideStylePreview: '看大图预览',
      sideCharPreview: '看大图预览',
      sideCharRefNone: '还没有参考图',
      sideViewerKindCharacter: '角色参考图',
      sideViewerKindArtist: '画师串预览',
      sideViewerZoom: '放大 / 缩小',
      sideStyleTotal: 'artist strings',
      sideStyleOff: 'None',
      sideStylePerMode: 'Comic separately',
      sideStyleApplies: 'Applies to render, img2img and inpaint',
      sideAddFromLib: 'Add from characters',
      sideAddRow: 'Character',
      sideArtCopy: 'copy',
      sideArtCover: 'Use latest render as cover',
      sideArtCoverDone: 'Cover replaced with this image',
      sideArtCoverHint: 'Makes the newest render this artist string\'s preview; the text stays as it is',
      sideArtCreated: 'Saved as a new artist string',
      sideArtDelete: 'Delete this one',
      sideArtDeleted: 'Artist string deleted',
      sideArtDiscard: 'Discard',
      sideArtEdited: 'edited',
      sideArtMine: 'mine',
      sideArtName: 'Name',
      sideArtNegative: 'Negative',
      sideArtNone: 'No artist string selected',
      sideArtOverrideBadge: 'changed',
      sideArtOverrideOn: 'Artist text changed for this render',
      sideArtPositive: 'Positive',
      sideArtRevert: 'Restore original',
      sideArtReverted: 'Original artist text restored',
      sideArtSave: 'Save to this one',
      sideArtSaveNew: 'Save as new',
      sideArtSaved: 'Saved to this artist string',
      sideArtText: 'Text',
      sideArtTextHint: 'Edits here apply to the next renders only; save them to keep them. The archive files are never changed.',
      sideAttachHint: 'You can also drop or paste an image',
      sideAttachImage: 'Attach reference',
      sideAttempts: 'tries',
      sideCallSize: 'This render',
      sideCallSizeHint: 'The size the model suggested, used for the next renders only; click to go back to the default size',
      sideCancel: 'Cancel',
      sideCaption: 'Current prompt',
      sideCharCase: 'Case-sensitive',
      sideCharAiDone: 'Rewritten; check it, then save',
      sideCharAiEdit: 'Edit features with a prompt',
      sideCharAiEmpty: 'Write what to change first',
      sideCharAiHint: 'The prompt model rewrites the fixed features and outfits from this one instruction. The result only fills the form; nothing is saved yet.',
      sideCharAiPh: 'e.g. silver-white hair, add a black lace eyepatch, remove the animal ears',
      sideCharAiRun: 'Rewrite',
      sideCharAiRunning: 'Rewriting…',
      sideCharDna: 'Fixed features (DNA)',
      sideCharDnaHint: 'What never changes between pictures: character tag, hair, eyes, build, species traits, signature accessories. Leave clothing, pose and expression out.',
      sideCharEdit: 'Edit character',
      sideCharEditShort: 'Edit',
      sideCharEmpty: 'No characters yet. Create one, or generate one from an image.',
      sideCharGroup: 'Group',
      sideCharHowTo: 'When the description mentions a character keyword, that character\'s DNA goes to the prompt writer; "Use now" sends it regardless. With "Replace character keywords" on, keywords in the prompt become the fixed features at render time.',
      sideCharImported: 'Characters imported',
      sideCharKeywords: 'Keywords',
      sideCharKeywordsHint: 'Comma-separated; regex allowed, e.g. /hatsune\\s*miku/i',
      sideCharName: 'Name',
      sideCharNameNeeded: 'Give the character a name',
      sideCharNegative: 'Must not appear',
      sideCharNew: 'New character',
      sideCharNoDna: '(no fixed features yet)',
      sideCharOwnRules: 'Own matching rules',
      sideCharPick: 'Use now',
      sideCharPickHint: 'Send this character to the prompt writer without a keyword match',
      sideCharSaved: 'Character saved',
      sideCharSearch: 'Search characters, keywords or features',
      sideCharToRow: 'Add to prompt',
      sideCharTok: 'Character',
      sideCharUnpick: 'Stop using',
      sideCharVarAdd: 'Variable feature',
      sideCharVarName: 'Name, e.g. uniform',
      sideCharVarPrompt: 'Tags',
      sideCharVariable: 'Variable features (outfits, looks)',
      sideCharWhole: 'Whole words',
      sideChars: 'Characters',
      sideCharsShort: 'chars',
      sideClear: 'Clear',
      sideConfirmDelete: 'Click again to confirm',
      sideDnaChange: 'Click to change, or drop or paste an image',
      sideDnaDone: 'Character draft ready; check it, then save',
      sideDnaDraft: 'draft',
      sideDnaDrop: 'Click to pick an image, or drop or paste one',
      sideDnaFromImage: 'DNA from image',
      sideDnaHelp: 'The model reads the picture and writes the character\'s fixed features and the outfit shown. The result fills the edit form; nothing is saved yet.',
      sideDnaHintPh: 'Optional note, e.g. "my OC Xiaoxue, the ears are fox ears"',
      sideDnaNoImage: 'Pick an image first',
      sideDecode: 'Decode',
      sideDecodeHint: 'json (default) mirrors the nai-dbgen「auto」mode: a base64 envelope, about a third larger; zip is the smallest transfer; auto sends */* and decodes whatever comes back.',
      sideDecodeJson: 'json (base64, default)',
      sideDecodeZip: 'zip (smallest)',
      sideDecodeAuto: 'auto (sniff)',
      sideDnaRun: 'Generate DNA',
      sideDnaRunning: 'Reading…',
      sideEditWithChars: 'Characters in "Current prompt" are sent too:',
      sideExport: 'Export',
      sideGroupActive: 'enabled',
      sideGroupActiveHint: 'A disabled group takes no part in keyword matching or replacement',
      sideGroupDelete: 'Delete the group and its characters',
      sideGroupName: 'Group name',
      sideGroupNew: 'Group',
      sideGroupRename: 'Rename',
      sideImageBig: 'The image is over 8 MB; use a smaller one',
      sideImageType: 'Only PNG, JPEG, WebP or GIF images',
      sideImport: 'Import',
      sideJsonBad: 'The file is not valid JSON',
      sideLlm: 'Prompt model',
      sideLlmDefault: 'Following the DSH default model',
      sideLlmFollow: 'Follow the DSH default model',
      sideLlmMaxTokens: 'Output cap',
      sideLlmOff: 'Prompt writing unavailable',
      sideLlmOffShort: 'unavailable',
      sideLlmPinned: 'Set in the plugin',
      sideLlmPending: 'Not saved yet. After Save, prompts use: ',
      sideLlmRetries: 'Retries on bad format',
      sideLlmRoute: 'Model',
      sideLlmRouteHint: 'The list comes from DSH\'s model settings. Reverse prompting and DNA from image need a model that takes images (marked 👁).',
      sideLlmVisionNo: 'no image input',
      sideLlmVisionUnknown: 'image input unknown',
      sideLlmVisionYes: 'takes images',
      sideMarket: 'Tag market',
      sideMarketEmpty: 'No tag market imported. Import a categorised tag JSON, then click a tag to insert it at the caret.',
      sideMarketHint: 'A tag goes in at the caret of the prompt field you used last; click it again to take it out.',
      sideMarketImported: 'Tags imported',
      sideMarketNone: 'not imported',
      sideMarketSearch: 'Search tag names or content',
      sideMarketTags: 'tags',
      sideMoveDown: 'Move down',
      sideMoveUp: 'Move up',
      sideNegative: 'Negative',
      sideNoAnalysis: 'The model wrote no analysis.',
      sideNoiseSchedule: 'Noise schedule',
      sideNoiseV5: 'V5 always uses karras',
      sidePickRefs: 'Pick references',
      sideAddChar: '添加角色',
      sideAddCharBlank: '空白角色（手填）',
      sideCharTagHint: '点一下展开 / 收起这个角色的提示词',
      sidePosAuto: 'auto',
      sidePosition: 'Position',
      sidePositionHint: 'Pick the character\'s cell on the 5×5 grid; click the chosen cell again for automatic. Arrow keys move, Delete clears.',
      sidePositive: 'Positive',
      sidePresetDiscard: 'Discard changes',
      sidePresetDna: 'DNA from image',
      sidePresetDnaHint: 'Variable: {{补充说明}}. The model must return one JSON object only.',
      sidePresetReset: 'Reset to default',
      sidePresetSystem: 'System prompt',
      sidePresetUser: 'User message',
      sidePresetWrite: 'Write prompt',
      sidePresetWriteHint: 'Variables: {{用户描述}} {{角色库}} {{参考条目}} {{画面尺寸}}. Output must use the scene / scene_uc / char / char_uc fields.',
      sidePresets: 'Prompt presets',
      sidePresetsSum: 'write prompt · DNA from image',
      sideRefImage: 'Reference',
      sideRefPick: 'Use as reference',
      sideRefPickHint: 'Send this entry\'s text to the prompt writer',
      sideRefToI2i: 'Use for img2img',
      sideRefUnpick: 'Stop using',
      sideRemove: 'Remove',
      sideReplaceKw: 'Replace character keywords',
      sideReplaceKwHint: 'At render time, swap character keywords in the prompt for that character\'s fixed features',
      sideReplaceKwOn: 'Keywords become DNA',
      sideReverse: 'Reverse',
      sideReverseDone: 'Prompt written from the reference; check it, then render',
      sideReverseHint: 'Write the prompt below from the reference image and the description; nothing is rendered',
      sideReverseResult: 'Reverse result',
      sideRowName: 'Label (not sent)',
      sideRowPlaceholder: 'Tags for this character',
      sideScenePlaceholder: 'Scene, composition, headcount, e.g. 2girls, classroom, sunset',
      sideSeed: 'Seed',
      sideSeedRandom: 'Random seed',
      sideSeedReuse: 'Reuse last seed',
      sideVarietyHint: 'V4.5 Variety+: more varied pictures, less repeated composition',
      sideAnlas: 'Anlas',
      sideBalance: 'Balance',
      sideBalanceHint: 'Read remaining Anlas and V5 energy with the token; renders nothing, costs nothing.',
      sideBalanceRefresh: 'Refresh',
      sideCharRef: 'Reference image',
      sideCharRefArtist: 'Use current artist string',
      sideCharRefDone: 'Reference image rendered and set as the character cover',
      sideCharRefGen: 'Render reference',
      sideCharRefHint: 'Renders a solo full-body picture from the fixed features (optionally one variable feature), keeps it in recent renders and sets it as the cover.',
      sideCharRefLatest: 'Use latest render',
      sideCharRefRemove: 'Remove reference',
      sideCharRefRunning: 'Rendering',
      sideCharRefVariantNone: 'Fixed features only',
      sideConfirmDeleteAll: 'Click again to delete all',
      sideDeleteAll: 'Delete all',
      sideDeleteRender: 'Delete',
      sideDeleteSelected: 'Delete selected',
      sideDeleted: 'Deleted',
      sideEnergy: 'Energy',
      sideEnergyEmpty: 'Energy used up',
      sideEnergyFull: 'full',
      sideEnergyRefill: 'to +1%',
      sideGalleryCount: 'images',
      sideGalleryEmptyAll: 'No renders yet.',
      sideGalleryHint: 'Renders live in the output directory; an image and its record are deleted together. "Keep newest" deletes older ones; "Keep at most" trims automatically after each render (0 = never).',
      sideGalleryManage: 'Manage renders',
      sideInsertChar: 'Character',
      sideInsertCharHint: 'Writes a character keyword into the description so the prompt writer gets that character’s DNA',
      sideModelCustom: 'Custom…',
      sideModelHint: 'Curated is trained on curated data and is steadier; Full covers more subjects. V5 Curated has no inpainting model, so inpainting uses V5 Full.',
      sideNavGallery: 'Renders',
      sideRenderCancelled: 'Render cancelled',
      sideRenderReceived: 'received',
      sideRenderSlow: 'No result yet usually means the relay is slow to send the image: keep waiting, or cancel and retry',
      sideRenderWaiting: 'Rendering',
      sideSelect: 'Select',
      sideSelectAll: 'Select all',
      sideTrimKeep: 'Keep newest',
      sideLog: 'Log',
      sideLogItems: 'entries',
      sideLogErrors: 'errors',
      sideLogHint: 'Every prompt-writer, DNA-from-image and render call is recorded here for troubleshooting. Tokens and image data are never written; kept for 14 days.',
      sideLogAll: 'All',
      sideLogWrite: 'Writer',
      sideLogRender: 'Renders',
      sideLogDna: 'Image DNA',
      sideLogCharacter: 'Rewrites',
      sideLogErrorsOnly: 'Problems only',
      sideLogEmpty: 'No log entries yet.',
      sideLogDownload: 'Download today',
      sideLogClear: 'Clear log',
      sideLogCleared: 'Log cleared',
      sideLogOpen: 'View log',
      sideLogDir: 'Log folder',
      sideLogEvent_write: 'writer',
      sideLogEvent_dna: 'image DNA',
      sideLogEvent_render: 'render',
      sideLogEvent_director: 'director',
      sideLogEvent_probe: 'probe',
      sideLogEvent_balance: 'balance',
      sideLogEvent_character: 'character rewrite',
      sideLogEvent_error: 'error',
      sideLogEvent_log: 'log',
      sideWriteRefused: 'The model refused this request (content moderation)',
      sideWriteInvalid: 'The model did not return a prompt in the format',
      sideWriteRaw: 'Raw model reply',
      sideWriteAttempts: '{n} attempt(s)',
      sideBooksEmptyHint: 'No reference library is indexed yet, so it is hidden in the library tab. Put the world-book JSONs (names containing 标签库 / 常规模板 / 扩展库 / 同人库 / SEX模板) into the source folder below and click Rebuild index; the reference library then appears.',
      sideTransparent: 'Transparent',
      sideTransparentHint: 'Render with an alpha channel (V5 only). Takes effect at once.',
      sideTransparentV5: 'Transparent backgrounds are a V5 feature.',
      sideTransparentOffHint: 'Renders come out transparent; click to turn it off',
      sideSmeaHint: 'SMEA applies to V3 models only; V4 and later have no such option.',
      sideViewer: 'View render',
      sideViewerCopy: 'Copy prompt',
      sideViewerCover: 'Set as artist cover',
      sideViewerDownload: 'Download',
      sideViewerLoad: 'Load into workbench',
      sideViewerLoaded: 'This image\'s prompt is in the workbench',
      sideViewerNext: 'Next',
      sideViewerNoMeta: 'No record for this image',
      sideViewerPrev: 'Previous',
      sideVisionOff: 'The current model declares no image input, so the reference will not reach it. Pick a 👁 model under Settings → Prompt model.',
      sideWrite: 'Write prompt',
      sideWriteCancelled: 'Prompt writing cancelled',
      sideWriteDone: 'Prompt written; check it, then render',
      sideWriteEmpty: 'Describe the picture, or attach a reference image',
      sideWriteHint: 'Turns the description into the structured prompt below with the model set up in DSH; nothing is rendered (Ctrl+Enter)',
      sideWriteModel: 'Model used for writing',
      sideWritePlaceholder: 'Describe the picture in plain words, e.g. Hatsune Miku sitting on a rooftop after rain, a city at dusk behind her. You can paste or drop a reference image.',
      sideWriteResult: 'Writer result',
      sideWriteTitle: 'Describe the picture',
      sideWriting: 'Writing…'
    }

    /**
     * One API call against the Host half.
     * @param path - route below the API prefix.
     * @param init - optional fetch init.
     * @returns the parsed JSON body.
     */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`${response.status}: ${text.slice(0, 200)}`)
      }
      // The body's other fields (code, logId, issues, raw …) travel with the error,
      // so a caller can show them or point at the log entry.
      if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), body, { status: response.status })
      return body
    }

    /** Design-token shortcuts with literal fallbacks. */
    const token = (name, fallback) => `var(${name}, ${fallback})`

    const label = {
      display: 'block',
      fontSize: 12,
      lineHeight: '18px',
      color: token('--dsw-alias-label-tertiary', '#888')
    }
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      height: 30,
      padding: '0 8px',
      fontSize: 13,
      borderRadius: token('--dsw-radius-md', '6px'),
      border: `1px solid ${token('--dsw-alias-border-l1', '#d0d0d5')}`,
      // `--dsw-alias-fill-l1` does not exist in the theme, so its #fff fallback
      // forced every field white in dark mode while text stayed inherited. Use the
      // real surface and label tokens; nothing else about the panel changes.
      background: token('--dsw-alias-bg-layer-1', '#fff'),
      color: token('--dsw-alias-label-primary', '#111'),
      outline: 'none'
    }
    const row = { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }
    const cell = (grow) => ({ flex: `${grow ?? 1} 1 120px`, minWidth: 96 })
    const button = (primary) => ({
      height: 30,
      padding: '0 14px',
      fontSize: 13,
      borderRadius: token('--dsw-radius-md', '6px'),
      border: `1px solid ${primary ? 'transparent' : token('--dsw-alias-border-l1', '#d0d0d5')}`,
      cursor: 'pointer',
      background: primary ? token('--dsw-alias-accent', '#2d6cff') : 'transparent',
      color: primary ? '#fff' : 'inherit'
    })
    const section = {
      marginTop: 18,
      paddingTop: 14,
      borderTop: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`
    }
    const card = {
      marginTop: 10,
      padding: 12,
      borderRadius: token('--dsw-radius-lg', '10px'),
      border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
      background: token('--dsw-alias-fill-l1', 'transparent')
    }

    // ------------------------------------------------------------- workbench --
    /** Where the sidebar workbench keeps its unsaved draft between sessions. */
    const WB_DRAFT_KEY = 'nai-imagegen:workbench-draft'
    /** NovelAI V4+ takes at most six character captions. */
    const WB_MAX_CHARACTERS = 6

    /** @returns the stored draft, or `{}`. */
    function readWbDraft() {
      try {
        if (typeof localStorage === 'undefined') return {}
        const value = JSON.parse(localStorage.getItem(WB_DRAFT_KEY) || '{}')
        return value !== null && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    /** @param draft - the draft to store; failures (private mode, quota) only mean it is not remembered. */
    function writeWbDraft(draft) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(WB_DRAFT_KEY, JSON.stringify(draft))
      } catch {
        /* not remembered this time */
      }
    }

    let wbRowSeq = 0
    /** @returns a fresh key for a character row. */
    const wbRowKey = () => `r${Date.now().toString(36)}${(wbRowSeq += 1)}`

    /**
     * NovelAI's 5×5 character grid: columns A–E left to right, rows 1–5 top to
     * bottom, each cell's centre as the coordinate (the mapping lib/nai.js uses).
     * @param col - 0..4.
     * @param row - 0..4.
     * @returns `{ x, y }`.
     */
    const wbCellPoint = (col, row) => ({ x: Number((col * 0.2 + 0.1).toFixed(2)), y: Number((row * 0.2 + 0.1).toFixed(2)) })
    /**
     * The grid cell nearest a point.
     * @param center - `{ x, y }` or nothing.
     * @returns `{ col, row, label }` or `null` for "arrange automatically".
     */
    /**
     * The NovelAI tags inside a DNA or feature text (same rule as lib/characters.js
     * `promptTags`): a labelled tag line such as `外观标签：…` wins, otherwise the runs
     * of Latin-script tags; plain tag text comes back unchanged, prose-only gives ''.
     */
    function wbPromptTags(text) {
      const source = String(text ?? '').trim()
      if (source === '') return ''
      const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/
      if (!cjk.test(source)) return source
      const labelled = source
        .split('\n')
        .map((line) => /^\s*(?:外观标签|标签|提示词|tags?|prompt)\s*[:：]\s*(.+)$/i.exec(line)?.[1]?.trim() ?? '')
        .filter((line) => line !== '' && !cjk.test(line))
      if (labelled.length > 0) return labelled.join(', ')
      const runs = source.match(/[A-Za-z0-9][A-Za-z0-9 _\-:'.()]*(?:,\s*[A-Za-z0-9][A-Za-z0-9 _\-:'.()]*)*/g) ?? []
      return runs
        .map((run) => run.trim().replace(/[.\s]+$/, ''))
        .filter((run) => /[A-Za-z]/.test(run) && /[ ,]/.test(run))
        .join(', ')
    }

    /** A log entry's time in the viewer's own clock (the log stores ISO / UTC). */
    function wbLogTime(at) {
      const date = new Date(String(at ?? ''))
      if (Number.isNaN(date.getTime())) return String(at ?? '')
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function wbCellOf(center) {
      if (center === null || typeof center !== 'object') return null
      const x = Number(center.x)
      const y = Number(center.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      const col = Math.min(4, Math.max(0, Math.floor(x * 5)))
      const row = Math.min(4, Math.max(0, Math.floor(y * 5)))
      return { col, row, label: `${'ABCDE'[col]}${row + 1}` }
    }

    /**
     * A floating preview window.
     *
     * A modal card rather than a full-window takeover: the sidebar is where the
     * work happens, and covering the whole app to look at one picture left the
     * page behind showing through. The backdrop closes it, 关闭 sits in the
     * corner of the card, and the actions stay in the bar at the bottom.
     *
     * It takes plain entries rather than gallery files, so a character's cover
     * image and an artist string's preview open here exactly like a render does.
     * ←/→ step through the list sliding in the direction of travel, Home/End
     * jump, +/−/0 zoom, a click toggles 2×, a drag while zoomed pans, Esc closes,
     * and focus returns to whatever opened it.
     *
     * @param options - `{ entries, index, t, onEdit(name), onLoad(meta, name),
     *   onCover(name)|null, onDelete(name)|null }`. An entry is
     *   `{ name, src, kind: 'gallery'|'character'|'artist' }`.
     */
    function openWbViewer(options) {
      if (typeof document === 'undefined') return
      const t = options.t
      const entries = (options.entries ?? []).filter((entry) => entry && entry.src)
      if (entries.length === 0) return
      let index = Math.min(entries.length - 1, Math.max(0, Number(options.index) || 0))
      const opener = document.activeElement
      document.querySelector('[data-nai-viewer]')?.remove()

      /** Zoom state: 1 = fit, above that the picture follows the pointer. */
      let zoom = 1
      const pan = { x: 0, y: 0 }
      let meta = null

      const root = document.createElement('div')
      root.className = 'nai-s nai-s-viewer'
      root.setAttribute('data-nai-viewer', '1')
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-modal', 'true')
      root.setAttribute('aria-label', t('sideViewer'))

      const panel = document.createElement('div')
      panel.className = 'nai-s-viewer-panel'

      const head = document.createElement('div')
      head.className = 'nai-s-viewer-head'
      const headText = document.createElement('div')
      headText.className = 'nai-s-viewer-headtext'
      const name = document.createElement('div')
      name.className = 'nai-s-viewer-name'
      const detail = document.createElement('div')
      detail.className = 'nai-s-viewer-detail nai-s-mono'
      headText.append(name, detail)
      head.append(headText)

      const stage = document.createElement('div')
      stage.className = 'nai-s-viewer-stage'
      const frame = document.createElement('div')
      frame.className = 'nai-s-viewer-frame'
      const img = document.createElement('img')
      img.alt = ''
      img.draggable = false
      img.setAttribute(IMG_ATTR, '1')
      img.setAttribute('data-nai-kind', 'gallery')
      frame.append(img)
      stage.append(frame)

      const prev = document.createElement('button')
      prev.type = 'button'
      prev.className = 'nai-s-viewer-nav'
      prev.dataset.dir = 'prev'
      prev.setAttribute('aria-label', t('sideViewerPrev'))
      prev.textContent = '‹'
      const next = prev.cloneNode()
      next.dataset.dir = 'next'
      next.setAttribute('aria-label', t('sideViewerNext'))
      next.textContent = '›'
      stage.append(prev, next)

      const strip = document.createElement('div')
      strip.className = 'nai-s-viewer-strip'
      strip.setAttribute('role', 'tablist')
      strip.setAttribute('aria-label', t('sideViewer'))

      const bar = document.createElement('div')
      bar.className = 'nai-s-viewer-bar'
      const acts = document.createElement('div')
      acts.className = 'nai-s-viewer-acts'
      bar.append(acts)

      const button = (label, onClick, kind) => {
        const node = document.createElement('button')
        node.type = 'button'
        node.className = 'nai-s-btn'
        node.dataset.size = 's'
        if (kind) node.dataset.kind = kind
        node.textContent = label
        node.addEventListener('click', onClick)
        return node
      }
      const flash = (node, text) => {
        const old = node.textContent
        node.textContent = text
        setTimeout(() => {
          if (node.isConnected) node.textContent = old
        }, 1400)
      }

      const closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.className = 'nai-s-viewer-close'
      closeButton.setAttribute('aria-label', t('i2iClose'))
      closeButton.title = `${t('i2iClose')} (Esc)`
      closeButton.append(Object.assign(document.createElement('span'), { className: 'nai-s-viewer-close-x', textContent: '✕' }))
      closeButton.append(Object.assign(document.createElement('span'), { textContent: t('i2iClose') }))
      closeButton.addEventListener('click', () => close())
      head.append(closeButton)

      const download = document.createElement('a')
      download.className = 'nai-s-btn'
      download.dataset.size = 's'
      download.textContent = t('sideViewerDownload')
      const copy = button(t('sideViewerCopy'), async () => {
        const text = String(meta?.request?.prompt ?? '')
        if (text === '') return flash(copy, t('sideViewerNoMeta'))
        try {
          await copyTextToClipboard(text)
          flash(copy, t('sideCopied'))
        } catch {
          flash(copy, t('failed'))
        }
      })
      const load = button(t('sideViewerLoad'), () => {
        if (meta === null) return flash(load, t('sideViewerNoMeta'))
        options.onLoad(meta, entries[index].name)
        close()
      })
      const edit = button(t('sideEditThis'), () => {
        options.onEdit(entries[index].name)
        close()
      })
      const cover =
        typeof options.onCover === 'function'
          ? button(t('sideViewerCover'), async () => {
              cover.disabled = true
              try {
                await options.onCover(entries[index].name)
                flash(cover, t('studioSaved'))
              } catch (error) {
                flash(cover, `${t('failed')}：${error.message}`)
              } finally {
                cover.disabled = false
              }
            })
          : null
      const remove =
        typeof options.onDelete === 'function'
          ? button(t('sideDeleteRender'), async () => {
              // Two clicks, like the sidebar: the first arms, the second deletes.
              if (remove.dataset.armed !== '1') {
                remove.dataset.armed = '1'
                remove.textContent = t('sideConfirmDelete')
                setTimeout(() => {
                  if (remove.isConnected) {
                    remove.dataset.armed = ''
                    remove.textContent = t('sideDeleteRender')
                  }
                }, 3500)
                return
              }
              remove.disabled = true
              try {
                await options.onDelete(entries[index].name)
                entries.splice(index, 1)
                if (entries.length === 0) return close()
                index = Math.min(index, entries.length - 1)
                remove.dataset.armed = ''
                remove.textContent = t('sideDeleteRender')
                paint()
              } catch (error) {
                flash(remove, `${t('failed')}：${error.message}`)
              } finally {
                remove.disabled = false
              }
            }, 'danger')
          : null
      const zoomButton = button('1×', () => setZoom(zoom > 1 ? 1 : 2))
      zoomButton.setAttribute('aria-label', t('sideViewerZoom'))
      acts.append(...[download, copy, load, edit, cover, remove, zoomButton].filter(Boolean))

      panel.append(head, stage, strip, bar)
      root.append(panel)

      const applyZoom = () => {
        frame.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`
        stage.dataset.zoomed = zoom > 1 ? '1' : undefined
        zoomButton.textContent = zoom > 1 ? `${zoom}×` : '1×'
      }
      const setZoom = (value) => {
        zoom = Math.min(4, Math.max(1, Number(value) || 1))
        if (zoom === 1) {
          pan.x = 0
          pan.y = 0
        }
        applyZoom()
      }
      const replay = (node, frames) => {
        node.style.animation = 'none'
        void node.offsetWidth
        node.style.animation = frames
      }

      const paintStrip = () => {
        strip.replaceChildren()
        if (entries.length < 2) {
          strip.hidden = true
          return
        }
        strip.hidden = false
        const from = Math.max(0, index - 6)
        const to = Math.min(entries.length, index + 7)
        for (let at = from; at < to; at += 1) {
          const entry = entries[at]
          const cell = document.createElement('button')
          cell.type = 'button'
          cell.className = 'nai-s-viewer-cell'
          cell.setAttribute('role', 'tab')
          cell.setAttribute('aria-selected', at === index ? 'true' : 'false')
          cell.title = entry.name
          const thumb = document.createElement('img')
          thumb.src = entry.src
          thumb.alt = ''
          thumb.loading = 'lazy'
          thumb.decoding = 'async'
          thumb.setAttribute(IMG_ATTR, '1')
          thumb.setAttribute('data-nai-kind', 'gallery')
          cell.append(thumb)
          cell.addEventListener('click', () => {
            if (at === index) return
            step(at - index)
          })
          strip.append(cell)
        }
        strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
      }

      const paint = (dir) => {
        const entry = entries[index]
        const gallery = entry.kind === 'gallery'
        img.src = entry.src
        img.setAttribute('data-nai-name', entry.name)
        download.href = entry.src
        download.setAttribute('download', entry.name)
        name.textContent = gallery ? `${index + 1} / ${entries.length} · ${entry.name}` : entry.name
        detail.textContent = gallery ? '' : t(`sideViewerKind${entry.kind === 'character' ? 'Character' : 'Artist'}`)
        meta = null
        prev.disabled = index === 0
        next.disabled = index === entries.length - 1
        // Only a render has provenance to copy, load back or re-cover.
        copy.hidden = !gallery
        load.hidden = !gallery
        edit.hidden = !gallery
        if (cover) cover.hidden = !gallery
        if (remove) remove.hidden = !gallery
        setZoom(1)
        if (dir !== undefined) replay(frame, dir === 'next' ? 'nai-step-next .26s cubic-bezier(.16,1,.3,1) both' : 'nai-step-prev .26s cubic-bezier(.16,1,.3,1) both')
        paintStrip()
        if (!gallery) return
        const wanted = entry.name
        api(`/file-meta?name=${encodeURIComponent(entry.name)}`)
          .then((body) => {
            if (entries[index]?.name !== wanted) return
            meta = body
            const request = body?.request ?? {}
            const row = (body?.files ?? []).find((item) => item.name === wanted) ?? {}
            detail.textContent = [
              row.seed ? `seed ${row.seed}` : null,
              request.width && request.height ? `${request.width}×${request.height}` : row.size,
              request.steps ? `${request.steps} steps` : null,
              request.model,
              request.artist ? `${t('artist')} ${request.artist}` : null
            ]
              .filter(Boolean)
              .join(' · ')
          })
          .catch(() => {})
      }
      const step = (delta, absolute) => {
        const target = absolute === undefined ? index + delta : absolute
        if (target < 0 || target >= entries.length || target === index) return
        index = target
        paint(delta >= 0 ? 'next' : 'prev')
      }
      const onKey = (event) => {
        const key = event.key
        if (key === 'Escape') {
          event.preventDefault()
          close()
        } else if (key === 'ArrowLeft') {
          event.preventDefault()
          step(-1)
        } else if (key === 'ArrowRight') {
          event.preventDefault()
          step(1)
        } else if (key === 'Home') {
          event.preventDefault()
          step(-1, 0)
        } else if (key === 'End') {
          event.preventDefault()
          step(1, entries.length - 1)
        } else if (key === '+' || key === '=') {
          event.preventDefault()
          setZoom(zoom + 1)
        } else if (key === '-' || key === '_') {
          event.preventDefault()
          setZoom(zoom - 1)
        } else if (key === '0') {
          event.preventDefault()
          setZoom(1)
        }
      }
      function close() {
        document.removeEventListener('keydown', onKey, true)
        root.classList.add('is-closing')
        const done = () => {
          root.remove()
          if (opener && typeof opener.focus === 'function') opener.focus()
        }
        // Exit faster than the entrance, and never leave a node behind.
        setTimeout(done, 130)
      }
      prev.addEventListener('click', () => step(-1))
      next.addEventListener('click', () => step(1))
      stage.addEventListener('click', (event) => {
        if (event.target !== stage && event.target !== frame) return
        setZoom(zoom > 1 ? 1 : 2)
      })
      // The backdrop closes; the card itself never does.
      root.addEventListener('pointerdown', (event) => {
        if (event.target === root) close()
      })
      stage.addEventListener('pointermove', (event) => {
        if (zoom <= 1) return
        const rect = stage.getBoundingClientRect()
        const half = (zoom - 1) / 2
        pan.x = (0.5 - (event.clientX - rect.left) / rect.width) * rect.width * half * 2
        pan.y = (0.5 - (event.clientY - rect.top) / rect.height) * rect.height * half * 2
        applyZoom()
      })
      stage.addEventListener('pointerleave', () => {
        if (zoom <= 1) return
        pan.x = 0
        pan.y = 0
        applyZoom()
      })
      document.addEventListener('keydown', onKey, true)
      document.body.append(root)
      paint()
      applyZoom()
      requestAnimationFrame(() => root.classList.add('is-open'))
      closeButton.focus()
    }

    // ------------------------------------------------------ sidebar workbench --
    /** Samplers NovelAI accepts, offered as suggestions; the field stays free text. */
    const SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde', 'ddim_v3']
    /** Model ids known to work; also suggestions only. */
    /** Text-to-image models, used until the host reports its own list (`status.models`). */
    const MODEL_FALLBACK = [
      { id: 'nai-diffusion-5-curated', label: 'NAI Diffusion V5 Curated', family: 'v5' },
      { id: 'nai-diffusion-5-full', label: 'NAI Diffusion V5 Full', family: 'v5' },
      { id: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated', family: 'v4.5' },
      { id: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full', family: 'v4.5' },
      { id: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion V4 Curated', family: 'v4' },
      { id: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full', family: 'v4' },
      { id: 'nai-diffusion-3', label: 'NAI Diffusion Anime V3', family: 'v3' }
    ]
    const MODELS = MODEL_FALLBACK.map((model) => model.id)
    /** Form fields the save path diffs; everything else in the config has its own writer. */
    const FORM_FIELDS = [
      'baseUrl', 'model', 'decode', 'proxy', 'width', 'height', 'steps', 'scale', 'sampler', 'ucPreset', 'header',
      'negativePrompt', 'outputDir', 'sourceDir', 'libraryDir', 'librarySourceDir', 'maxImagesPerCall', 'keepImages',
      'cfgRescale', 'noiseSchedule', 'variety', 'smea', 'llmProvider', 'llmModel', 'llmMaxTokens', 'writerRetries'
    ]

    /**
     * The sidebar's stylesheet.
     *
     * Every colour, radius and font comes from the host's `--dsw-*` tokens, read
     * from the running shell, so the panel follows light and dark themes and the
     * host's own black primary. The one deliberate addition is a monospace face
     * for parameter values: a collapsed card still shows what it holds.
     */
    const SIDE_CSS = `
.nai-s{--ink:var(--dsw-alias-label-primary,#0f1115);--ink2:var(--dsw-alias-label-secondary,#61666b);--ink3:var(--dsw-alias-label-tertiary,#81858c);--ink4:var(--dsw-alias-label-caption,#adb2b8);--line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.04));--line-strong:var(--dsw-alias-border-l4,rgba(0,0,0,.16));--paper:var(--dsw-alias-bg-layer-1,#fff);--wash:var(--dsw-alias-bg-module-platform,#f5f6f7);--hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));--press:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));--primary:var(--dsw-alias-brand-primary,#0f1115);--on-primary:var(--dsw-alias-label-primary-foreground,#fff);--ok:#1f9d55;--warn:#c27c0e;--bad:#d93025;--r-sm:var(--dsw-radius-sm,8px);--r-md:var(--dsw-radius-md,12px);--mono:var(--dsw-font-markdown-code-font-family,"SF Mono",Consolas,monospace);--focus:0 0 0 2px var(--paper),0 0 0 4px var(--ink3);display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:1.5;color:var(--ink);background:var(--paper)}
.nai-s *{box-sizing:border-box}
.nai-s [hidden]{display:none!important}
.nai-s-head{flex:none;border-bottom:1px solid var(--line-soft)}
.nai-s-status{display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px 4px;border:0;background:none;color:var(--ink2);font:inherit;font-size:11.5px;letter-spacing:.01em;text-align:left;cursor:pointer}
.nai-s-status:hover .nai-s-status-txt{color:var(--ink)}
.nai-s-status:focus-visible{outline:none;box-shadow:var(--focus);border-radius:var(--r-sm)}
.nai-s-status-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-mono{font-family:var(--mono);font-size:11.5px;letter-spacing:-.01em}
.nai-s-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--ink4)}
.nai-s-dot[data-ok="1"]{background:var(--ok)}
.nai-s-dot[data-ok="0"]{background:var(--bad)}
.nai-s-dot[data-ok="w"]{background:var(--warn)}
.nai-s-nav{display:flex;gap:2px;padding:4px 10px 0}
.nai-s-tab{position:relative;flex:1;padding:9px 4px 10px;border:0;background:none;color:var(--ink3);font:inherit;font-size:13px;cursor:pointer;border-radius:var(--r-sm) var(--r-sm) 0 0}
.nai-s-tab:hover{color:var(--ink)}
.nai-s-tab[aria-selected="true"]{color:var(--ink);font-weight:600}
.nai-s-tab[aria-selected="true"]::after{content:"";position:absolute;left:22%;right:22%;bottom:-1px;height:2px;border-radius:2px;background:var(--ink)}
.nai-s-tab:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-flash{display:flex;gap:8px;align-items:flex-start;margin:8px 14px 0;padding:8px 11px;border-radius:var(--r-md);font-size:12px;line-height:1.5;word-break:break-word}
.nai-s-flash[data-tone="bad"]{background:color-mix(in srgb,var(--bad) 9%,transparent);color:var(--bad)}
.nai-s-flash[data-tone="ok"]{background:color-mix(in srgb,var(--ok) 10%,transparent);color:var(--ok)}
.nai-s-flash>span{flex:1}
.nai-s-flash>button{flex:none;border:0;background:none;color:inherit;font:inherit;cursor:pointer;opacity:.7;padding:0 2px}
.nai-s-body{flex:1;min-height:0;overflow-y:auto;padding:14px 14px 34px;scrollbar-gutter:stable}
.nai-s-pane{display:flex;flex-direction:column;gap:12px}
.nai-s-stack{display:flex;flex-direction:column;gap:12px}
.nai-s-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nai-s-sp{flex:1}
.nai-s-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px}
.nai-s-grid>.nai-s-wide{grid-column:1/-1}
.nai-s-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.nai-s-label{font-size:11px;font-weight:500;letter-spacing:.04em;color:var(--ink3)}
.nai-s-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--ink3)}
.nai-s-hint code,.nai-s-cmd{font-family:var(--mono);font-size:11.5px}
.nai-s-cmd{display:block;padding:7px 9px;border-radius:var(--r-sm);background:var(--wash);color:var(--ink2);user-select:all;word-break:break-all}
.nai-s-path{font-family:var(--mono);font-size:11px;color:var(--ink3);word-break:break-all}
.nai-s-in{width:100%;height:32px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--paper);color:var(--ink);font:inherit;font-size:13px;outline:none;transition:border-color .12s}
.nai-s-in.nai-s-mono{font-family:var(--mono);font-size:12px}
textarea.nai-s-in{height:auto;padding:7px 9px;resize:vertical;line-height:1.5}
select.nai-s-in{padding-right:4px}
.nai-s-in:hover{border-color:var(--line-strong)}
.nai-s-in:focus{border-color:var(--ink3);box-shadow:0 0 0 3px color-mix(in srgb,var(--ink3) 16%,transparent)}
input[type=range].nai-s-range{width:100%;accent-color:var(--primary)}
.nai-s-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--paper);color:var(--ink);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s,opacity .12s}
.nai-s-btn:hover:not(:disabled){background:var(--hover);border-color:var(--line-strong)}
.nai-s-btn:active:not(:disabled){background:var(--press)}
.nai-s-btn:disabled{opacity:.45;cursor:default}
.nai-s-btn:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-btn[data-kind="primary"]{background:var(--primary);border-color:var(--primary);color:var(--on-primary);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--primary) 28%,transparent)}
.nai-s-btn[data-kind="primary"]:hover:not(:disabled){background:var(--primary);opacity:.86}
.nai-s-btn[data-kind="ghost"]{border-color:transparent;background:none;color:var(--ink2)}
.nai-s-btn[data-kind="ghost"]:hover:not(:disabled){color:var(--ink)}
.nai-s-btn[data-kind="danger"]:hover:not(:disabled){color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.nai-s-btn[data-size="s"]{height:24px;padding:0 8px;font-size:12px}
.nai-s-btn[aria-pressed="true"]{background:var(--press);border-color:var(--line-strong)}
.nai-s-seg{display:flex;padding:2px;border-radius:var(--r-sm);background:var(--wash)}
.nai-s-seg>button{flex:1;height:26px;border:0;border-radius:calc(var(--r-sm) - 2px);background:none;color:var(--ink3);font:inherit;font-size:12px;cursor:pointer}
.nai-s-seg>button:hover{color:var(--ink)}
.nai-s-seg>button[aria-pressed="true"]{background:var(--paper);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--line-soft)}
.nai-s-seg>button:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-composer{border:1px solid var(--line);border-radius:var(--r-md);background:var(--paper);overflow:hidden;transition:border-color .12s}
.nai-s-composer:focus-within{border-color:var(--ink3);box-shadow:0 0 0 3px var(--hover)}
.nai-s-composer textarea{display:block;width:100%;min-height:96px;padding:10px 12px;border:0;outline:none;resize:vertical;background:none;color:var(--ink);font-family:var(--mono);font-size:12.5px;line-height:1.6}
.nai-s-composer-bar{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border-top:1px solid var(--line-soft);background:var(--wash)}
.nai-s-composer-bar .nai-s-in{width:auto;height:28px}
.nai-s-receipt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink3)}
.nai-s-pills{display:flex;flex-wrap:wrap;gap:6px}
.nai-s-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:0;border-radius:11px;background:var(--wash);color:var(--ink2);font:inherit;font-size:11.5px}
.nai-s-pill[data-tone="ok"]{color:var(--ok);background:color-mix(in srgb,var(--ok) 10%,transparent)}
.nai-s-pill[data-tone="warn"]{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}
.nai-s-pill[data-tone="bad"]{color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
button.nai-s-pill{cursor:pointer}
button.nai-s-pill:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-card{border:1px solid var(--line);border-radius:var(--r-md);background:var(--paper);box-shadow:0 1px 2px color-mix(in srgb,var(--ink) 4%,transparent);transition:border-color .15s,box-shadow .15s}
.nai-s-card:hover{border-color:var(--line-strong);box-shadow:0 2px 6px color-mix(in srgb,var(--ink) 7%,transparent)}
.nai-s-card>summary{display:flex;align-items:baseline;gap:10px;padding:10px 12px;list-style:none;cursor:pointer;border-radius:var(--r-md)}
.nai-s-card>summary::-webkit-details-marker{display:none}
.nai-s-card>summary::before{content:"";flex:none;align-self:center;width:6px;height:6px;margin-right:-2px;border-right:1.5px solid var(--ink3);border-bottom:1.5px solid var(--ink3);transform:rotate(-45deg);transition:transform .15s}
.nai-s-card[open]>summary::before{transform:rotate(45deg)}
.nai-s-card>summary:hover{background:var(--hover)}
.nai-s-card>summary:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-card-title{flex:none;font-size:13px;font-weight:600;letter-spacing:.01em}
.nai-s-card-sum{flex:1;min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink3)}
.nai-s-card-body{display:flex;flex-direction:column;gap:10px;padding:2px 12px 12px}
.nai-s-switch{display:flex;align-items:flex-start;gap:10px}
.nai-s-switch>div{flex:1;min-width:0}
.nai-s-switch-name{font-size:13px}
.nai-s-switch-btn{position:relative;flex:none;width:34px;height:20px;margin-top:1px;border:0;border-radius:10px;background:var(--line-strong);cursor:pointer;transition:background .15s}
.nai-s-switch-btn::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.nai-s-switch-btn[aria-checked="true"]{background:var(--primary)}
.nai-s-switch-btn[aria-checked="true"]::after{transform:translateX(14px)}
.nai-s-switch-btn:disabled{opacity:.5}
.nai-s-switch-btn:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-sect{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--line-soft);font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--ink3)}
.nai-s-shot{position:relative;display:block;overflow:hidden;border-radius:var(--r-sm);border:1px solid var(--line-soft);background:repeating-conic-gradient(color-mix(in srgb,var(--ink) 7%,transparent) 0% 25%,transparent 0% 50%) 50%/14px 14px}
.nai-s-shot img{display:block;width:100%;height:100%;object-fit:cover}
.nai-s-shot[data-hero="1"]{height:min(46vh,520px)}
.nai-s-shot[data-hero="1"] img{object-fit:contain}
.nai-s-shot-act{position:absolute;right:6px;bottom:6px;opacity:0;transition:opacity .12s}
.nai-s-shot:hover .nai-s-shot-act,.nai-s-shot:focus-within .nai-s-shot-act{opacity:1}
.nai-s-shot-act .nai-s-btn{height:24px;padding:0 9px;font-size:12px;background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(6px)}
.nai-s-shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:6px}
.nai-s-shots .nai-s-shot{aspect-ratio:2/3}
.nai-s-empty{padding:30px 18px;border:1px dashed var(--line);border-radius:var(--r-md);background:color-mix(in srgb,var(--wash) 55%,transparent);color:var(--ink3);font-size:12px;line-height:1.6;text-align:center}
.nai-s-pick{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:var(--r-md)}
.nai-s-pick-thumb{flex:none;width:52px;height:72px;overflow:hidden;border-radius:6px;background:var(--wash)}
.nai-s-pick-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.nai-s-pick-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.nai-s-pick-name{font-size:12px;color:var(--ink2);word-break:break-all}
.nai-s-canvas{position:relative;overflow:hidden;align-self:center;width:min(100%,calc(52vh * var(--ar,0.684)));border:1px solid var(--line);border-radius:var(--r-md);background:repeating-conic-gradient(color-mix(in srgb,var(--ink) 7%,transparent) 0% 25%,transparent 0% 50%) 50%/14px 14px}
.nai-s-canvas canvas{display:block;width:100%;height:auto}
.nai-s-canvas canvas+canvas{position:absolute;inset:0;height:100%;opacity:.45;cursor:crosshair;touch-action:none}
.nai-s-artists{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:min(56vh,560px);overflow-y:auto;padding:1px}
.nai-s-artist{display:flex;gap:8px;align-items:center;padding:5px;border:1px solid var(--line-soft);border-radius:var(--r-sm);background:none;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.nai-s-artist:hover{background:var(--hover)}
.nai-s-artist[aria-pressed="true"]{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.nai-s-artist:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-artist img,.nai-s-artist-ph{flex:none;width:34px;height:48px;border-radius:4px;object-fit:cover;background:var(--wash)}
.nai-s-artist-name{flex:1;min-width:0;line-height:1.35;word-break:break-word}
.nai-s-current{display:flex;gap:10px;align-items:center;padding:8px;border-radius:var(--r-md);background:var(--wash)}
.nai-s-current img{flex:none;width:44px;height:62px;border-radius:6px;object-fit:cover}
.nai-s-chips{display:flex;flex-wrap:wrap;gap:6px}
.nai-s-chip{display:inline-flex;align-items:baseline;gap:5px;height:26px;padding:0 10px;border:1px solid var(--line);border-radius:13px;background:none;color:var(--ink2);font:inherit;font-size:12px;cursor:pointer}
.nai-s-chip:hover{border-color:var(--line-strong);color:var(--ink)}
.nai-s-chip[aria-pressed="true"]{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}
.nai-s-chip[data-missing="1"]{border-style:dashed;color:var(--ink4)}
.nai-s-chip:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-chip-n{font-family:var(--mono);font-size:10.5px;opacity:.75}
.nai-s-hit{padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-md)}
.nai-s-hit-head{display:flex;align-items:baseline;gap:8px}
.nai-s-hit-title{flex:1;min-width:0;font-weight:600;word-break:break-word}
.nai-s-hit-lib{flex:none;font-size:11px;color:var(--ink3)}
.nai-s-hit-keys{margin-top:2px;font-size:11.5px;color:var(--ink3);word-break:break-word}
.nai-s-hit pre{margin:8px 0 0;padding:8px 10px;max-height:9.5em;overflow:hidden;border-radius:var(--r-sm);background:var(--wash);color:var(--ink2);font-family:var(--mono);font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.nai-s-hit pre[data-open="1"]{max-height:none}
.nai-s-hit-acts{display:flex;gap:6px;margin-top:8px}
.nai-s-keyrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 10px;align-items:center;padding:8px 0;border-top:1px solid var(--line-soft)}
.nai-s-keyrow:first-child{border-top:0;padding-top:0}
.nai-s-keyrow .nai-s-dot{grid-row:span 2}
.nai-s-keyrow-acts{grid-row:span 2;display:flex;gap:4px}
.nai-s-checks{display:flex;flex-direction:column;gap:3px;max-height:300px;overflow-y:auto;font-size:12px}
.nai-s-check{display:flex;gap:7px;align-items:baseline}
.nai-s-check>.nai-s-dot{align-self:center}
.nai-s-check-name{flex:1;min-width:0}
.nai-s-check-detail{display:block;color:var(--ink3);font-size:11px;word-break:break-all}
.nai-s-savebar{flex:none;display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--line);background:var(--wash)}
.nai-s-savebar>span{flex:1;font-size:12px;color:var(--ink2)}
@container (max-width:300px){.nai-s-grid{grid-template-columns:minmax(0,1fr)}.nai-s-artists{grid-template-columns:minmax(0,1fr)}}
.nai-s-write{border:1px solid var(--line);border-radius:var(--r-md);background:var(--paper);overflow:hidden;transition:border-color .12s}
.nai-s-write:focus-within{border-color:var(--ink3);box-shadow:0 0 0 3px var(--hover)}
.nai-s-write[data-drop="1"]{border-color:var(--ink);border-style:dashed}
.nai-s-write-head{display:flex;align-items:center;gap:8px;padding:8px 12px 0;font-size:12px;color:var(--ink3)}
.nai-s-write textarea{display:block;width:100%;min-height:64px;padding:6px 12px 8px;border:0;outline:none;resize:vertical;background:none;color:var(--ink);font:inherit;font-size:13px;line-height:1.55}
.nai-s-attach{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px}
.nai-s-tok{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:26px;padding:0 4px 0 6px;border:1px solid var(--line);border-radius:13px;background:var(--wash);color:var(--ink2);font-size:12px}
.nai-s-tok>img{width:18px;height:18px;border-radius:4px;object-fit:cover}
.nai-s-tok>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-tok>button{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:none;color:var(--ink3);font:inherit;line-height:1;cursor:pointer}
.nai-s-tok>button:hover{background:var(--press);color:var(--ink)}
.nai-s-tok[data-kind="char"]{border-color:color-mix(in srgb,var(--ink) 25%,transparent)}
.nai-s-write-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 6px 6px 8px;border-top:1px solid var(--line-soft);background:var(--wash)}
.nai-s-check-inline{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--ink2);cursor:pointer}
.nai-s-check-inline input{accent-color:var(--primary);margin:0}
.nai-s-cap{display:flex;flex-direction:column;gap:8px}
.nai-s-cap-head{display:flex;align-items:center;gap:8px}
.nai-s-cap-head>strong{font-size:12px;font-weight:600;color:var(--ink2)}
.nai-s-cap-tools>select{flex:0 1 auto;width:auto;min-width:0;max-width:60%;height:24px;padding:0 6px;font-size:12px}
.nai-s-cap-head>select{width:auto;max-width:52%;height:24px;font-size:12px}
.nai-s-cap-pair{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:6px}
.nai-s-cap-pair textarea{min-height:58px}
.nai-s-cap-pair textarea.nai-s-neg{background:color-mix(in srgb,var(--bad) 3%,var(--paper))}
.nai-s-charrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.nai-s-adder{width:auto;max-width:14em;height:26px;padding:0 8px;border-radius:999px;font-size:12px;color:var(--ink2);flex:0 1 auto}
.nai-s-adder:hover{border-color:var(--line-strong);color:var(--ink)}
.nai-s-chartag{display:inline-flex;align-items:center;overflow:hidden;border:1px solid var(--line);border-radius:999px;background:var(--paper);animation:nai-rise-in .2s cubic-bezier(.16,1,.3,1) both}
.nai-s-chartag[data-open="1"]{border-color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,var(--paper))}
.nai-s-chartag-main{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 2px 0 10px;border:0;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;border-radius:999px 0 0 999px}
.nai-s-chartag-main:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-chartag-name{max-width:9.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.nai-s-chartag-pos{padding:0 5px;border-radius:6px;background:var(--wash);color:var(--ink3);font-family:var(--mono);font-size:10.5px;line-height:16px}
.nai-s-chartag[data-open="1"] .nai-s-chartag-pos{background:var(--paper);color:var(--ink2)}
.nai-s-chartag-x{display:flex;align-items:center;justify-content:center;width:22px;height:26px;border:0;background:none;color:var(--ink3);font:inherit;font-size:13px;line-height:1;cursor:pointer;border-radius:0 999px 999px 0}
.nai-s-chartag-x:hover{background:var(--press);color:var(--ink)}
.nai-s-chartag-x:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-row-card{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 10px;padding:8px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--paper)}
.nai-s-row-card>.nai-s-cap-pair{grid-column:2}
.nai-s-row-top{grid-column:2;display:flex;align-items:center;gap:6px;min-width:0}
.nai-s-row-top>input{flex:1;min-width:0;height:24px;font-size:12px}
.nai-s-row-num{font-family:var(--mono);font-size:11px;color:var(--ink3)}
.nai-s-grid5{grid-row:1/span 2;display:grid;grid-template-columns:repeat(5,12px);grid-auto-rows:12px;gap:2px;align-self:start;padding:3px;border-radius:6px;background:var(--wash);outline:none}
.nai-s-grid5:focus-visible{box-shadow:var(--focus)}
.nai-s-grid5>span{border-radius:2px;background:color-mix(in srgb,var(--ink) 9%,transparent);cursor:pointer}
.nai-s-grid5>span:hover{background:color-mix(in srgb,var(--ink) 25%,transparent)}
.nai-s-grid5>span[data-on="1"]{background:var(--ink)}
.nai-s-grid5[data-auto="1"]>span[data-mid="1"]{box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ink) 30%,transparent)}
.nai-s-grid5-cap{grid-row:3;justify-self:center;font-family:var(--mono);font-size:10px;color:var(--ink3)}
.nai-s-market{display:flex;flex-direction:column;gap:8px}
.nai-s-market-tabs{display:flex;flex-wrap:wrap;gap:4px}
.nai-s-market-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:4px;max-height:260px;overflow-y:auto;padding:1px}
.nai-s-tag{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:5px 7px;border:1px solid var(--line-soft);border-radius:var(--r-sm);background:var(--paper);color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.nai-s-tag:hover{background:var(--hover)}
.nai-s-tag[aria-pressed="true"]{border-color:var(--ink);background:color-mix(in srgb,var(--ink) 6%,var(--paper))}
.nai-s-tag:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-tag>b{font-size:12px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-tag>i{font-style:normal;font-family:var(--mono);font-size:10.5px;color:var(--ink3);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-seed{display:inline-flex;align-items:center;gap:2px}
.nai-s-seed>input{width:96px;height:28px}
.nai-s-chars{display:flex;flex-direction:column;gap:6px}
.nai-s-cgroup{border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}
.nai-s-cgroup-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--wash)}
.nai-s-cgroup-head>strong{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-cgroup[data-off="1"] .nai-s-char{opacity:.55}
.nai-s-char{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-top:1px solid var(--line-soft)}
.nai-s-char-head{display:flex;align-items:baseline;gap:8px}
.nai-s-char-head>strong{flex:1;min-width:0;font-size:13px;word-break:break-word}
.nai-s-char-keys{font-size:11.5px;color:var(--ink3);word-break:break-word}
.nai-s-char-dna{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-family:var(--mono);font-size:11.5px;color:var(--ink2);word-break:break-word}
.nai-s-char-acts{display:flex;flex-wrap:wrap;gap:4px}
.nai-s-char[data-picked="1"]{background:color-mix(in srgb,var(--ink) 4%,transparent)}
.nai-s-editor{display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--line-strong);border-radius:var(--r-md);background:var(--paper);box-shadow:0 6px 22px rgba(0,0,0,.06)}
.nai-s-editor-title{display:flex;align-items:center;gap:8px;font-weight:600}
.nai-s-varrow{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,2fr) auto;gap:6px;align-items:start}
.nai-s-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:120px;padding:14px;border:1.5px dashed var(--line-strong);border-radius:var(--r-md);background:var(--wash);color:var(--ink3);font-size:12.5px;text-align:center;cursor:pointer}
.nai-s-drop:hover,.nai-s-drop[data-drop="1"]{border-color:var(--ink);color:var(--ink)}
.nai-s-drop:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-drop>img{max-width:100%;max-height:220px;border-radius:8px;object-fit:contain}
.nai-s-artedit{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid var(--line-soft);background:var(--wash)}
.nai-s-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn);font-size:10.5px;font-weight:600}
.nai-s-viewer{position:fixed;inset:0;z-index:2147483200;display:grid;place-items:center;padding:4vh 3vw;background:rgba(8,9,11,.52);backdrop-filter:blur(7px);color:#f3f4f6;--ink:#f3f4f6;--ink2:#d1d5db;--ink3:#9ca3af;--paper:rgba(32,33,36,.92);--wash:rgba(255,255,255,.06);--line:rgba(255,255,255,.16);--line-strong:rgba(255,255,255,.28);--hover:rgba(255,255,255,.08);--press:rgba(255,255,255,.14);opacity:0;transition:opacity .16s ease}
.nai-s-viewer.is-open{opacity:1}
.nai-s-viewer.is-closing{opacity:0;transition-duration:.12s}
.nai-s-viewer-panel{display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;width:min(94vw,980px);height:min(88vh,760px);overflow:hidden;border-radius:16px;background:#111318;box-shadow:0 28px 80px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);transform:scale(.97) translateY(6px);transition:transform .2s cubic-bezier(.16,1,.3,1)}
.nai-s-viewer.is-open .nai-s-viewer-panel{transform:none}
.nai-s-viewer.is-closing .nai-s-viewer-panel{transform:scale(.98);transition-duration:.12s}
.nai-s-viewer-head{display:flex;align-items:center;gap:12px;padding:10px 10px 10px 14px;border-bottom:1px solid rgba(255,255,255,.1)}
.nai-s-viewer-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.nai-s-viewer-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}
.nai-s-viewer-detail{color:#9ca3af;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-viewer-close{flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px 0 10px;border:1px solid rgba(255,255,255,.24);border-radius:999px;background:rgba(255,255,255,.1);color:#fff;font:inherit;font-size:12.5px;cursor:pointer;transition:background .14s,border-color .14s,transform .1s}
.nai-s-viewer-close:hover{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.4)}
.nai-s-viewer-close:active{transform:scale(.96)}
.nai-s-viewer-close:focus-visible{outline:none;box-shadow:0 0 0 2px #fff}
.nai-s-viewer-close-x{font-size:13px;line-height:1}
.nai-s-viewer-stage{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;padding:14px 52px;overflow:hidden;cursor:zoom-in;background:#0c0e12}
.nai-s-viewer-stage[data-zoomed="1"]{cursor:zoom-out}
.nai-s-viewer-frame{width:100%;height:100%;display:flex;align-items:center;justify-content:center;transform-origin:center;transition:transform .22s cubic-bezier(.16,1,.3,1);will-change:transform}
.nai-s-viewer-frame>img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 12px 40px rgba(0,0,0,.5);background:repeating-conic-gradient(#2a2b2f 0% 25%,#212226 0% 50%) 50%/16px 16px;-webkit-user-select:none;user-select:none;animation:nai-fade .24s ease both}
.nai-s-viewer-nav{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:56px;border:0;border-radius:9px;background:rgba(255,255,255,.08);color:#fff;font-size:26px;line-height:1;cursor:pointer;opacity:0;transition:opacity .16s,background .16s}
.nai-s-viewer-stage:hover .nai-s-viewer-nav,.nai-s-viewer-nav:focus-visible{opacity:1}
.nai-s-viewer-nav[data-dir="prev"]{left:8px}
.nai-s-viewer-nav[data-dir="next"]{right:8px}
.nai-s-viewer-nav:hover:not(:disabled){background:rgba(255,255,255,.18)}
.nai-s-viewer-nav:disabled{opacity:0;cursor:default}
.nai-s-viewer-nav:focus-visible{outline:none;box-shadow:0 0 0 2px #fff}
.nai-s-viewer-strip{display:flex;gap:6px;overflow-x:auto;padding:8px 12px;background:rgba(255,255,255,.03);border-top:1px solid rgba(255,255,255,.08);scrollbar-width:thin;scroll-behavior:smooth}
.nai-s-viewer-cell{flex:none;width:42px;height:56px;padding:0;overflow:hidden;border:0;border-radius:6px;background:rgba(255,255,255,.06);cursor:pointer;opacity:.5;transition:opacity .15s,box-shadow .15s,transform .15s}
.nai-s-viewer-cell>img{display:block;width:100%;height:100%;object-fit:cover}
.nai-s-viewer-cell:hover{opacity:.85}
.nai-s-viewer-cell[aria-selected="true"]{opacity:1;box-shadow:0 0 0 2px #fff;transform:translateY(-2px)}
.nai-s-viewer-cell:focus-visible{outline:none;box-shadow:0 0 0 2px #fff}
.nai-s-viewer-bar{display:flex;align-items:center;padding:8px 12px;background:rgba(255,255,255,.04);border-top:1px solid rgba(255,255,255,.08)}
.nai-s-viewer-acts{display:flex;flex-wrap:wrap;gap:6px}
.nai-s-viewer-acts [hidden]{display:none!important}
.nai-s-viewer .nai-s-btn{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.18);color:#f3f4f6;text-decoration:none}
.nai-s-viewer .nai-s-btn:hover:not(:disabled){background:rgba(255,255,255,.16)}
.nai-s-viewer .nai-s-btn[data-kind="danger"]{color:#ffb4ae;border-color:rgba(255,120,110,.4)}
@media (max-width:720px){.nai-s-viewer{padding:2vh 2vw}.nai-s-viewer-panel{width:98vw;height:94vh;border-radius:12px}.nai-s-viewer-stage{padding:8px 34px}.nai-s-viewer-nav{width:30px;height:44px;font-size:20px}.nai-s-viewer-head{padding:8px}.nai-s-viewer-close{padding:0 10px}}
.nai-s-body{container-type:inline-size}
.nai-s-flash-link{flex:none;border:0;background:none;color:inherit;font:inherit;font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:2px;cursor:pointer;opacity:1!important;padding:0 2px}
.nai-s-failcard{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--bad) 35%,var(--line));border-radius:var(--r-md);background:color-mix(in srgb,var(--bad) 5%,var(--paper));animation:nai-rise-in .2s cubic-bezier(.16,1,.3,1) both}
.nai-s-failcard-head{display:flex;align-items:center;gap:6px;color:var(--bad);font-size:12.5px}
.nai-s-failcard-msg{margin:0;font-size:12.5px;line-height:1.55;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.nai-s-failcard-issues{margin:0;padding-left:18px;font-size:12px;color:var(--ink2)}
.nai-s-failcard-raw>summary{cursor:pointer;font-size:12px;color:var(--ink2)}
.nai-s-logjson{max-height:280px;margin:6px 0;padding:8px 10px;overflow:auto;border-radius:var(--r-sm);background:var(--wash);color:var(--ink2);font-family:var(--mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.nai-s-loglist{display:flex;flex-direction:column;max-height:min(52vh,460px);overflow-y:auto;border:1px solid var(--line-soft);border-radius:var(--r-sm)}
.nai-s-logrow{border-bottom:1px solid var(--line-soft)}
.nai-s-logrow:last-child{border-bottom:0}
.nai-s-logrow-head{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:8px;align-items:baseline;width:100%;padding:6px 9px;border:0;background:none;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.nai-s-logrow-head:hover{background:var(--hover)}
.nai-s-logrow-head:focus-visible{outline:none;box-shadow:inset var(--focus)}
.nai-s-logrow-time{color:var(--ink3);font-size:10.5px}
.nai-s-logrow-event{padding:0 6px;border-radius:6px;background:var(--wash);color:var(--ink2);font-size:11px;white-space:nowrap}
.nai-s-logrow-sum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.nai-s-logrow[data-level="warn"] .nai-s-logrow-event{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.nai-s-logrow[data-level="error"] .nai-s-logrow-event{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}
.nai-s-logrow[data-open="1"]{background:var(--wash)}
.nai-s-logrow[data-open="1"] .nai-s-logrow-sum{white-space:normal}
.nai-s-logrow-body{padding:0 9px 8px}
.nai-s-flash[data-tone="busy"]{background:var(--wash);color:var(--ink2)}
.nai-s-flash[data-tone="busy"]>button{opacity:1;padding:0 8px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--paper);color:var(--ink)}
.nai-s-write-bar>select.nai-s-write-char{width:auto;max-width:42%;height:24px;padding:0 6px;font-size:12px}
.nai-s-balance{display:flex;flex-direction:column;gap:5px;padding-top:4px;border-top:1px solid var(--line-soft)}
.nai-s-balance-row{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:8px;align-items:center;font-size:12px}
.nai-s-balance-row>.nai-s-mono{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)}
.nai-s-balance-key{color:var(--ink2)}
.nai-s-gal-tile{padding:0;font:inherit;color:inherit;cursor:pointer}
.nai-s-gal-tile[aria-pressed="true"]{box-shadow:0 0 0 2px var(--ink)}
.nai-s-gal-tile:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-gal-check{position:absolute;top:5px;left:5px;display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line-strong);background:color-mix(in srgb,var(--paper) 85%,transparent);font-size:11px}
.nai-s-gal-check[data-on="1"]{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}
.nai-s-char-thumb{flex:none;display:block;width:40px;height:54px;padding:0;overflow:hidden;border:0;border-radius:6px;background:var(--wash);cursor:zoom-in;align-self:center;transition:transform .2s cubic-bezier(.16,1,.3,1),box-shadow .2s}
.nai-s-char-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.nai-s-char-thumb:hover{transform:translateY(-1px) scale(1.03);box-shadow:0 6px 16px rgba(0,0,0,.16)}
.nai-s-char-thumb:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-cover{display:flex;flex-direction:column;gap:0;overflow:hidden;border-radius:var(--r-md);background:var(--paper);box-shadow:0 0 0 1px var(--line)}
.nai-s-cover-art{position:relative;display:block;width:100%;aspect-ratio:16/10;max-height:min(38vh,300px);padding:0;border:0;background:var(--wash);cursor:zoom-in;overflow:hidden}
.nai-s-cover-art>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 28%;animation:nai-fade .3s ease both}
.nai-s-cover-art>.nai-s-swatch{position:absolute;inset:0;font-size:13px}
.nai-s-cover-scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(6,7,9,.88),rgba(6,7,9,.42) 46%,rgba(6,7,9,0));pointer-events:none}
.nai-s-cover-text{position:absolute;left:10px;right:10px;bottom:8px;display:flex;flex-direction:column;gap:1px;color:#fff;text-align:left;pointer-events:none}
.nai-s-cover-title{font-size:13px;font-weight:600;line-height:1.3;text-shadow:0 1px 3px rgba(0,0,0,.55);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.nai-s-cover-sub{font-size:11px;color:rgba(255,255,255,.78);font-family:var(--mono);letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-cover-zoom{position:absolute;top:8px;right:8px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:rgba(10,12,16,.5);backdrop-filter:blur(6px);color:#fff;font-size:12px;opacity:0;transition:opacity .15s}
.nai-s-cover-art:hover .nai-s-cover-zoom,.nai-s-cover-art:focus-visible .nai-s-cover-zoom{opacity:1}
.nai-s-cover-art:focus-visible{outline:none;box-shadow:inset 0 0 0 2px #fff}
.nai-s-cover-body{display:flex;flex-direction:column;gap:6px;padding:8px}
.nai-s-nav>.nai-s-tab{padding-left:2px;padding-right:2px}
.nai-s-style{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--r-md);background:var(--paper);overflow:hidden}
.nai-s-style[data-open="1"]{border-color:var(--line-strong);box-shadow:0 6px 22px rgba(0,0,0,.08)}
.nai-s-stylebar{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 8px}
.nai-s-stylebar[data-empty="1"]{background:var(--wash)}
.nai-s-stylebar-art{flex:none;width:44px;height:58px;padding:0;overflow:hidden;border:0;border-radius:8px;background:var(--wash);cursor:pointer}
.nai-s-stylebar-art img{display:block;width:100%;height:100%;object-fit:cover}
.nai-s-stylebar-art:focus-visible{outline:none;box-shadow:var(--focus)}
.nai-s-stylebar-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.nai-s-stylebar-label{font-size:11px;color:var(--ink3)}
.nai-s-stylebar-name{font-weight:600;font-size:13.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-stylebar[data-empty="1"] .nai-s-stylebar-name{font-weight:500;color:var(--ink2)}
.nai-s-stylebar-tags{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink3);font-size:11px}
.nai-s-stylebar-acts{flex:none;display:flex;gap:4px;align-items:center}
.nai-s-stylepick{display:flex;flex-direction:column;gap:8px;padding:10px;border-top:1px solid var(--line-soft);background:var(--wash)}
.nai-s-styles{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:9px;max-height:min(56vh,560px);overflow-y:auto;padding:2px}
.nai-s-stylecard{position:relative;aspect-ratio:3/4;overflow:hidden;border-radius:var(--r-md);background:var(--wash);box-shadow:0 0 0 1px var(--line-soft);animation:nai-card-in .26s cubic-bezier(.16,1,.3,1) both}
.nai-s-stylecard-pick{position:absolute;inset:0;display:block;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.nai-s-stylecard-art{position:absolute;inset:0;overflow:hidden}
.nai-s-stylecard-art img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .38s cubic-bezier(.16,1,.3,1);animation:nai-fade .3s ease both}
.nai-s-stylecard-art>.nai-s-swatch{position:absolute;inset:0;font-size:22px}
.nai-s-stylecard:hover .nai-s-stylecard-art img{transform:scale(1.07)}
.nai-s-stylecard-scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(6,7,9,.9),rgba(6,7,9,.4) 44%,rgba(6,7,9,0));pointer-events:none}
.nai-s-stylecard-text{position:absolute;left:9px;right:9px;bottom:8px;display:flex;flex-direction:column;gap:1px;color:#fff;pointer-events:none}
.nai-s-stylecard-name{font-size:12px;font-weight:600;line-height:1.3;word-break:break-all;text-shadow:0 1px 3px rgba(0,0,0,.55);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nai-s-stylecard-meta{font-family:var(--mono);font-size:10.5px;color:rgba(255,255,255,.72);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nai-s-stylecard[data-selected="1"]{box-shadow:0 0 0 2px var(--ink)}
.nai-s-stylecard[data-selected="1"] .nai-s-stylecard-name{color:#fff}
.nai-s-stylecard-pick:focus-visible{outline:none;box-shadow:inset 0 0 0 2px #fff}
.nai-s-stylecard-eye{position:absolute;top:7px;right:7px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:rgba(10,12,16,.52);backdrop-filter:blur(6px);color:#fff;font-size:12px;line-height:1;cursor:zoom-in;opacity:0;transform:scale(.88);transition:opacity .15s,transform .15s,background .15s}
.nai-s-stylecard:hover .nai-s-stylecard-eye,.nai-s-stylecard-eye:focus-visible{opacity:1;transform:none}
.nai-s-stylecard-eye:hover{background:rgba(10,12,16,.78)}
.nai-s-stylecard-eye:focus-visible{outline:none;box-shadow:0 0 0 2px #fff}
@media (hover:none){.nai-s-stylecard-eye{opacity:1;transform:none}.nai-s-stylecard-eye{position:absolute}}
.nai-s-swatch{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0 4px;text-align:center;line-height:1.25;word-break:break-all;background:hsl(var(--hue,220) 45% 88%);color:hsl(var(--hue,220) 35% 32%);font-size:14px;font-weight:600;letter-spacing:.02em}
body[data-ds-dark-theme] .nai-s-swatch{background:hsl(var(--hue,220) 22% 26%);color:hsl(var(--hue,220) 45% 82%)}
.nai-s-swatch[data-blank="1"]{background:var(--paper);color:var(--ink4);font-weight:400}
.nai-s-current .nai-s-swatch{flex:none;width:44px;height:62px;border-radius:6px}
.nai-s-artist .nai-s-swatch{flex:none;width:34px;height:48px;border-radius:4px;font-size:12px}
.nai-s-btn{will-change:auto}
.nai-s-btn:active:not(:disabled){transform:scale(.972)}
.nai-s-btn{transition:background .12s,border-color .12s,opacity .12s,transform .1s ease}
.nai-s-tab[aria-selected="true"]::after{animation:nai-tab-in .22s cubic-bezier(.16,1,.3,1) both}
.nai-s-pane:not([hidden]){animation:nai-fade .18s ease both}
.nai-s-flash{animation:nai-rise-in .2s cubic-bezier(.16,1,.3,1) both}
.nai-s-flash[data-tone="busy"]{position:relative;padding-left:22px}
.nai-s-flash[data-tone="busy"]::before{content:"";position:absolute;left:9px;top:50%;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:var(--ink);animation:nai-pulse 1.3s ease-in-out infinite}
.nai-s-stylepick,.nai-s-editor{animation:nai-rise-in .2s cubic-bezier(.16,1,.3,1) both}
.nai-s-char{animation:nai-card-in .26s cubic-bezier(.16,1,.3,1) both}
.nai-s-cgroup{animation:nai-fade .22s ease both}
.nai-s-shot,.nai-s-gal-tile{transition:transform .2s cubic-bezier(.16,1,.3,1),box-shadow .2s}
.nai-s-shot:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.14)}
.nai-s-shot img,.nai-s-charref-art img,.nai-s-char-thumb img{animation:nai-fade .3s ease both}
.nai-s-balance-row{animation:nai-fade .24s ease both}
@keyframes nai-fade{from{opacity:0}to{opacity:1}}
@keyframes nai-rise-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes nai-card-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
@keyframes nai-tab-in{from{opacity:0;transform:scaleX(.25)}to{opacity:1;transform:none}}
@keyframes nai-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}
@keyframes nai-step-next{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}
@keyframes nai-step-prev{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
.nai-s *,.nai-s *::before,.nai-s *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
.nai-s-viewer-nav{opacity:1!important}
.nai-s-flash[data-tone="busy"]::before{animation:nai-pulse 1.8s ease-in-out infinite!important;animation-duration:1.8s!important;animation-iteration-count:infinite!important}
}
`

    /** Whether this module instance has put its stylesheet into the document. */
    let sideStylesReady = false
    /** Put the sidebar stylesheet into the document once per module instance (an HMR reload replaces it). */
    function ensureSideStyles() {
      if (sideStylesReady || typeof document === 'undefined' || typeof document.createElement !== 'function') return
      let node = document.getElementById('nai-imagegen-side-css')
      if (node === null) {
        node = document.createElement('style')
        node.id = 'nai-imagegen-side-css'
        document.head.appendChild(node)
      }
      node.textContent = SIDE_CSS
      sideStylesReady = true
    }

    /**
     * The sidebar glyph. DSH renders it at 16 or 18 px and tells it whether the
     * panel is the active one.
     * @param props - injected `{ size, active }`.
     * @returns the svg element.
     */
    function PanelIcon(props) {
      const size = props.size ?? 18
      const color = props.active ? token('--dsw-alias-label-primary', '#111') : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' }
        },
        h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
        h('circle', { key: 'c', cx: 9, cy: 10, r: 1.6, fill: color, stroke: 'none' }),
        h('path', { key: 'm', d: 'M4 18l4.5-5 3 3 3.5-4L20 18' })
      )
    }

    /**
     * The panel page registered on the keyed `main` slot.
     * @param props - composed slot props; this component reads none of them.
     * @returns the panel element.
     */
    function NaiPanel(props) {
      const t = props.t ?? ((key) => key)
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [prompt, setPrompt] = React.useState('1girl, solo, standing, looking at viewer')
      const [variants, setVariants] = React.useState(1)
      const [shots, setShots] = React.useState([])
      const [probed, setProbed] = React.useState(null)
      // ---- image-to-image ----
      const [sources, setSources] = React.useState([])
      const [sourceName, setSourceName] = React.useState('')
      const [pickerOpen, setPickerOpen] = React.useState(false)
      /** Hidden `<input type="file">`; clicking it opens the OS file picker. */
      const fileInput = React.useRef(null)
      const [strength, setStrength] = React.useState(0.5)
      const [noise, setNoise] = React.useState(0)
      // Empty means "use the panel default size"; the field shows the resolved
      // number, so what is sent is always visible before the click.
      const [i2iWidth, setI2iWidth] = React.useState('')
      const [i2iHeight, setI2iHeight] = React.useState('')
      // ---- inpaint (mask editor) ----
      const [brush, setBrush] = React.useState(28)
      const [eraseMode, setEraseMode] = React.useState(false)
      const [maskDirty, setMaskDirty] = React.useState(false)
      const [inpaintStrength, setInpaintStrength] = React.useState(1)
      // The inpaint source is a finished render from the output gallery, not a
      // file in the source directory: the usual case is refining what this plugin
      // just produced. Its size is derived from the image so the request stays in
      // the free band, so these two are display-only.
      const [inpaintSource, setInpaintSource] = React.useState('')
      const [inpaintPickerOpen, setInpaintPickerOpen] = React.useState(false)
      /** Full gallery listing for the inpaint picker (the wall only holds the newest 120). */
      const [inpaintShots, setInpaintShots] = React.useState([])
      // Paged listings: one page of thumbnails is loaded, the rest on request.
      const [sourceTotal, setSourceTotal] = React.useState(0)
      const [inpaintTotal, setInpaintTotal] = React.useState(0)
      const [moreLoading, setMoreLoading] = React.useState(false)
      const [inpaintWidth, setInpaintWidth] = React.useState('')
      const [inpaintHeight, setInpaintHeight] = React.useState('')
      // ---- director tools ----
      const [directorType, setDirectorType] = React.useState('lineart')
      const [directorEmotion, setDirectorEmotion] = React.useState('')
      const baseCanvas = React.useRef(null)
      const maskCanvas = React.useRef(null)
      const paintingRef = React.useRef(false)
      // ---- sidebar layout ----
      // 插件页位置（layout !== 'side'）也渲染同一套侧栏布局：两处再也不会出现
      // 「网页版一套、插件页另一套」的分叉。宽度在下面按 layout 加约束。
      const side = true
      /** The config as last loaded or saved; the form is diffed against it. */
      const [baseline, setBaseline] = React.useState(null)
      const [sideNav, setSideNav] = React.useState('create')
      const [editTool, setEditTool] = React.useState('i2i')
      const [libView, setLibView] = React.useState('artists')
      const [libInfo, setLibInfo] = React.useState(null)
      const [libMode, setLibMode] = React.useState('lookup')
      const [libFilter, setLibFilter] = React.useState('')
      const [libQuery, setLibQuery] = React.useState('')
      const [libResult, setLibResult] = React.useState(null)
      const [libOpen, setLibOpen] = React.useState({})
      const [doctor, setDoctor] = React.useState(null)
      // ---- artist-string picker (sidebar) ----
      const [artistGroup, setArtistGroup] = React.useState('')
      const [stylePickerOpen, setStylePickerOpen] = React.useState(false)
      const [styleDetail, setStyleDetail] = React.useState(null)
      const styleSearch = React.useRef(null)
      // ---- workbench (sidebar) ----
      /** The draft as it was when the panel mounted; read once. */
      const wbDraft = React.useRef(null)
      if (wbDraft.current === null) wbDraft.current = side ? readWbDraft() : {}
      const draft0 = wbDraft.current
      const [nlText, setNlText] = React.useState(() => String(draft0.nlText ?? ''))
      const [refImage, setRefImage] = React.useState(null)
      const [pickedRefs, setPickedRefs] = React.useState(() => (Array.isArray(draft0.pickedRefs) ? draft0.pickedRefs : []))
      const [pickedChars, setPickedChars] = React.useState(() => (Array.isArray(draft0.pickedChars) ? draft0.pickedChars : []))
      const [baseNeg, setBaseNeg] = React.useState(() => String(draft0.baseNeg ?? ''))
      const [charRows, setCharRows] = React.useState(() =>
        (Array.isArray(draft0.charRows) ? draft0.charRows : [])
          .slice(0, WB_MAX_CHARACTERS)
          .map((row) => ({ key: wbRowKey(), name: String(row?.name ?? ''), positive: String(row?.positive ?? ''), negative: String(row?.negative ?? ''), center: row?.center ?? null }))
      )
      const [replaceKw, setReplaceKw] = React.useState(() => draft0.replaceKw === true)
      const [seedText, setSeedText] = React.useState(() => String(draft0.seedText ?? ''))
      const [lastSeed, setLastSeed] = React.useState(null)
      const [callSize, setCallSize] = React.useState(() => (draft0.callSize && Number(draft0.callSize.width) > 0 ? draft0.callSize : null))
      const [lastWrite, setLastWrite] = React.useState(null)
      const writeAbort = React.useRef(null)
      const refFileInput = React.useRef(null)
      const [writeDrop, setWriteDrop] = React.useState(false)
      const [llmInfo, setLlmInfo] = React.useState(null)
      const [llmModelList, setLlmModelList] = React.useState(null)
      const [presetData, setPresetData] = React.useState(null)
      const [presetDraft, setPresetDraft] = React.useState(null)
      const [presetTab, setPresetTab] = React.useState('write')
      const [charDoc, setCharDoc] = React.useState(null)
      const [charQuery, setCharQuery] = React.useState('')
      const [charEdit, setCharEdit] = React.useState(null)
      const [dnaOpen, setDnaOpen] = React.useState(false)
      const [dnaImage, setDnaImage] = React.useState(null)
      const [dnaHint, setDnaHint] = React.useState('')
      const [dnaDrop, setDnaDrop] = React.useState(false)
      const [aiEditText, setAiEditText] = React.useState('')
      const [aiEditNote, setAiEditNote] = React.useState('')
      const dnaFileInput = React.useRef(null)
      const charImportInput = React.useRef(null)
      const [groupEdit, setGroupEdit] = React.useState(null)
      const [market, setMarket] = React.useState(null)
      const [marketPath, setMarketPath] = React.useState(() => (Array.isArray(draft0.marketPath) ? draft0.marketPath : []))
      const [marketQuery, setMarketQuery] = React.useState('')
      const marketImportInput = React.useRef(null)
      const capFocus = React.useRef({ field: 'base', start: null, end: null })
      const [artistText, setArtistText] = React.useState(() =>
        draft0.artistText && typeof draft0.artistText === 'object' ? draft0.artistText : null
      )
      const [artEditOpen, setArtEditOpen] = React.useState(false)
      const [confirmKey, setConfirmKey] = React.useState('')
      // ---- batch 3 ----
      const renderAbort = React.useRef(null)
      const [renderProgress, setRenderProgress] = React.useState(null)
      const [busySince, setBusySince] = React.useState(0)
      const [, setTick] = React.useState(0)
      const [modelCustom, setModelCustom] = React.useState(false)
      const [balance, setBalance] = React.useState(null)
      const [balanceBusy, setBalanceBusy] = React.useState(false)
      const nlRef = React.useRef(null)
      const [galleryList, setGalleryList] = React.useState(null)
      const [galleryTotal, setGalleryTotal] = React.useState(0)
      const [galleryStats, setGalleryStats] = React.useState(null)
      const [gallerySel, setGallerySel] = React.useState([])
      const [gallerySelecting, setGallerySelecting] = React.useState(false)
      const [trimKeep, setTrimKeep] = React.useState('')
      const [charRefVariant, setCharRefVariant] = React.useState('')
      const [charRefArtist, setCharRefArtist] = React.useState(true)
      // ---- debug log ----
      const [logData, setLogData] = React.useState(null)
      const [logFilter, setLogFilter] = React.useState('all')
      const [logOpenId, setLogOpenId] = React.useState('')
      const [logBusy, setLogBusy] = React.useState(false)
      const [errorLog, setErrorLog] = React.useState(null)
      const [writeFail, setWriteFail] = React.useState(null)
      const logCardRef = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const next = await api('/status')
          setStatus(next)
          setShots(next.newest ?? [])
        } catch (err) {
          setError(err.message)
        }
      }, [])

      /**
       * Re-read the source directory.
       *
       * The list is a snapshot of a folder the user edits outside the panel, so
       * the current pick is kept only while it still exists — a deleted base
       * image must not stay selected and fail at render time.
       */
      const loadSources = React.useCallback(async () => {
        setBusy('sources')
        try {
          const body = await api('/sources?limit=120&offset=0')
          const files = body.files ?? []
          setSources(files)
          setSourceTotal(body.total ?? files.length)
          setSourceName((prev) => (prev !== '' && files.some((file) => file.name === prev) ? prev : (files[0]?.name ?? '')))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }, [])

      /** Append the next source page; already-known names are skipped. */
      const loadMoreSources = async () => {
        if (moreLoading) return
        setMoreLoading(true)
        try {
          const body = await api(`/sources?limit=120&offset=${sources.length}`)
          const files = body.files ?? []
          setSources((prev) => [...prev, ...files.filter((file) => !prev.some((row) => row.name === file.name))])
          setSourceTotal(body.total ?? sources.length + files.length)
        } catch (err) {
          setError(err.message)
        } finally {
          setMoreLoading(false)
        }
      }

      React.useEffect(() => {
        let live = true
        ;(async () => {
          try {
            const [statusBody, configBody, sourcesBody] = await Promise.all([
              api('/status'),
              api('/config'),
              api('/sources?limit=120&offset=0')
            ])
            if (!live) return
            setStatus(statusBody)
            setShots(statusBody.newest ?? [])
            setForm({ ...configBody, token: '' })
            setBaseline({ ...configBody, token: '' })
            const files = sourcesBody.files ?? []
            setSources(files)
            setSourceTotal(sourcesBody.total ?? files.length)
            setSourceName(files[0]?.name ?? '')
          } catch (err) {
            if (live) setError(err.message)
          }
        })()
        return () => {
          live = false
        }
      }, [])

      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))

      /**
       * Form fields that differ from what was last loaded or saved.
       *
       * Saving only these matters: the instant switches (auto-render, code-block
       * buttons, quality tags) and the per-mode studio write the config on their
       * own, and posting the whole form would put back the values it was loaded
       * with, silently undoing those switches.
       */
      const changedFields = () => {
        if (form === null) return []
        if (baseline === null) return Object.keys(form).filter((key) => key !== 'token')
        return FORM_FIELDS.filter((key) => String(form[key] ?? '') !== String(baseline[key] ?? ''))
      }

      const onSave = async () => {
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const patch = {}
          for (const key of changedFields()) patch[key] = form[key]
          if (form.token) patch.token = form.token
          if (Object.keys(patch).length === 0) {
            setNotice(t('saved'))
            return
          }
          // ucPreset 也在列：面板用 <select> 渲染它，取到的是字符串 "2"。
          // 后端 normalize 会强转，但其余数字字段都在这里转了，漏掉它会让
          // 「数字字段」的协议前后不一致，日后排查时容易误判。
          for (const numeric of ['width', 'height', 'steps', 'scale', 'ucPreset', 'maxImagesPerCall', 'keepImages', 'cfgRescale', 'llmMaxTokens', 'writerRetries']) {
            if (patch[numeric] !== undefined && patch[numeric] !== '') patch[numeric] = Number(patch[numeric])
          }
          if (!patch.token) delete patch.token
          const body = await api('/config', { method: 'POST', body: JSON.stringify(patch) })
          setStatus(body.status)
          setShots(body.status.newest ?? [])
          setBaseline({ ...form, token: '' })
          setForm((prev) => ({ ...prev, token: '' }))
          setNotice(t('saved'))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onRender = async () => {
        setBusy('render')
        const controller = new AbortController()
        renderAbort.current = controller
        setError('')
        setNotice('')
        const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        const stopProgress = watchRenderProgress(requestId)
        try {
          const body = await api('/generate', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              prompt,
              nSamples: Number(variants) || 1,
              requestId,
              ...sideExtras(),
              ...(side && callSize ? { width: callSize.width, height: callSize.height } : {})
            })
          })
          noteSeed(body)
          if (side) loadBalance()
          setNotice(`${body.files.length} 张 · 相对消耗 ${body.weight}`)
          await refresh()
        } catch (err) {
          if (err?.name === 'AbortError') setNotice(t('sideRenderCancelled'))
          else failWith(err)
        } finally {
          stopProgress()
          renderAbort.current = null
          setBusy('')
        }
      }

      /**
       * Render one image-to-image.
       *
       * The panel never holds the base image bytes: it sends the file name and
       * the Host reads the file under the source directory (`readBaseImage`),
       * which is also what enforces the size/format limits.
       */
      const onImg2Img = async () => {
        if (sourceName === '') {
          setError(t('i2iNoSources'))
          return
        }
        setBusy('i2i')
        const controller = new AbortController()
        renderAbort.current = controller
        setError('')
        setNotice('')
        const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        const stopProgress = watchRenderProgress(requestId)
        try {
          // Clamped here as well as on the Host: the notice reports the value
          // that was actually sent, so 1.2 typed into the field must not be
          // echoed as 1.2 when the request carried 0.99.
          const nextStrength = Math.min(0.99, Math.max(0.01, Number(strength) || 0.5))
          const nextNoise = Math.min(0.99, Math.max(0, Number(noise) || 0))
          const body = await api('/generate', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              prompt,
              sourceImage: sourceName,
              strength: nextStrength,
              noise: nextNoise,
              requestId,
              width: Number(i2iWidth) || status?.width,
              height: Number(i2iHeight) || status?.height,
              ...sideExtras()
            })
          })
          noteSeed(body)
          if (side) loadBalance()
          setStrength(nextStrength)
          setNoise(nextNoise)
          setNotice(`${body.files.length} · strength ${nextStrength} · ${body.weight}`)
          await refresh()
        } catch (err) {
          if (err?.name === 'AbortError') setNotice(t('sideRenderCancelled'))
          else failWith(err)
        } finally {
          stopProgress()
          renderAbort.current = null
          setBusy('')
        }
      }

      /**
       * Open the OS file picker.
       *
       * DSH's client services expose a directory picker but no file picker, so
       * this is the browser's own `<input type="file">` — the same dialog, no
       * native bridge needed. The picked bytes then travel to the Host, which
       * sniffs and stores them in the source directory; the renderer never
       * hands a path over.
       */
      const onPickFile = () => fileInput.current?.click()

      const onFileChosen = async (event) => {
        const file = event.target.files?.[0]
        // Reset first: picking the same file twice must fire again.
        event.target.value = ''
        if (!file) return
        setBusy('upload')
        setError('')
        setNotice('')
        try {
          const response = await fetch(`${API}/source-upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: await file.arrayBuffer()
          })
          const text = await response.text()
          let body = {}
          try {
            body = text === '' ? {} : JSON.parse(text)
          } catch {
            body = { error: text.slice(0, 200) }
          }
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          const latest = await api('/sources?limit=600')
          const files = latest.files ?? []
          setSources(files)
          // The upload becomes the single selection; nothing else is retained.
          setSourceName(body.name ?? files[0]?.name ?? '')
          setPickerOpen(false)
          setNotice(t('i2iUploaded'))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      // ---- inpaint: canvas mask editor -----------------------------------
      /** Snap to the same grid the Host uses, so the exported mask matches. */
      const snapAxis = (value, fallback) => {
        const n = Number(value)
        const base = Number.isFinite(n) && n > 0 ? n : Number(fallback) || 832
        return Math.min(2048, Math.max(64, Math.round(base / 64) * 64))
      }

      /** Largest snapped size with the image's ratio that stays inside the free band. */
      const freeBandSize = (width, height) => {
        const limit = 1024 * 1024
        const ratio = width > 0 && height > 0 ? width / height : 0.684
        let outWidth = Math.floor(Math.sqrt(limit * ratio) / 64) * 64
        let outHeight = Math.floor(outWidth / ratio / 64) * 64
        while (outWidth > 64 && outHeight > 64 && outWidth * outHeight > limit) {
          outWidth -= 64
          outHeight = Math.floor(outWidth / ratio / 64) * 64
        }
        return { width: Math.max(64, outWidth), height: Math.max(64, outHeight) }
      }

      /**
       * Pick a gallery render as the inpaint base.
       *
       * The canvas size comes from the image's own aspect ratio and the free-band
       * limit, so a portrait render redraws at ~832x1216, a landscape one at
       * ~1216x832 and a square one at 1024x1024 — all billed at 0 Anlas on Opus.
       */
      const chooseInpaintImage = (name) => {
        setInpaintSource(name)
        setInpaintPickerOpen(false)
        const image = new Image()
        image.onload = () => {
          const size = freeBandSize(image.naturalWidth, image.naturalHeight)
          setInpaintWidth(String(size.width))
          setInpaintHeight(String(size.height))
        }
        image.src = `${API}/file?name=${encodeURIComponent(name)}`
      }

      /** Open the inpaint picker with the gallery's first page. */
      const openInpaintPicker = async () => {
        setInpaintPickerOpen(true)
        try {
          const body = await api('/gallery?limit=120&offset=0')
          const files = body.files ?? []
          setInpaintShots(files)
          setInpaintTotal(body.total ?? files.length)
        } catch (err) {
          setError(err.message)
        }
      }

      /** Append the next gallery page for the inpaint picker. */
      const loadMoreInpaint = async () => {
        if (moreLoading) return
        setMoreLoading(true)
        try {
          const body = await api(`/gallery?limit=120&offset=${inpaintShots.length}`)
          const files = body.files ?? []
          setInpaintShots((prev) => [...prev, ...files.filter((file) => !prev.some((row) => row.name === file.name))])
          setInpaintTotal(body.total ?? inpaintShots.length + files.length)
        } catch (err) {
          setError(err.message)
        } finally {
          setMoreLoading(false)
        }
      }

      React.useEffect(() => {
        const bottom = baseCanvas.current
        const top = maskCanvas.current
        if (bottom === null || top === null) return undefined
        const width = snapAxis(inpaintWidth, status?.width)
        const height = snapAxis(inpaintHeight, status?.height)
        for (const canvas of [bottom, top]) {
          canvas.width = width
          canvas.height = height
        }
        const context = bottom.getContext('2d')
        context.clearRect(0, 0, width, height)
        top.getContext('2d').clearRect(0, 0, width, height)
        setMaskDirty(false)
        if (inpaintSource === '') return undefined
        // A load that finishes after another selection must not paint over it.
        let live = true
        const image = new Image()
        image.onload = () => {
          if (live) context.drawImage(image, 0, 0, width, height)
        }
        image.src = `${API}/file?name=${encodeURIComponent(inpaintSource)}`
        return () => {
          live = false
        }
      }, [inpaintSource, inpaintWidth, inpaintHeight, status?.width, status?.height])

      const maskPoint = (event) => {
        const canvas = maskCanvas.current
        const rect = canvas.getBoundingClientRect()
        return {
          x: (event.clientX - rect.left) * (canvas.width / rect.width),
          y: (event.clientY - rect.top) * (canvas.height / rect.height)
        }
      }

      const paintAt = (event) => {
        const canvas = maskCanvas.current
        if (canvas === null) return
        const context = canvas.getContext('2d')
        const point = maskPoint(event)
        const size = Number(brush) || 28
        context.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over'
        context.fillStyle = '#ff3b30'
        context.beginPath()
        context.arc(point.x, point.y, size / 2, 0, Math.PI * 2)
        context.fill()
        context.beginPath()
        context.moveTo(point.x, point.y)
        setMaskDirty(true)
      }

      const onMaskDown = (event) => {
        paintingRef.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        paintAt(event)
      }

      const onMaskMove = (event) => {
        if (!paintingRef.current) return
        const canvas = maskCanvas.current
        if (canvas === null) return
        const context = canvas.getContext('2d')
        const point = maskPoint(event)
        context.globalCompositeOperation = eraseMode ? 'destination-out' : 'source-over'
        context.strokeStyle = '#ff3b30'
        context.lineWidth = Number(brush) || 28
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.lineTo(point.x, point.y)
        context.stroke()
        setMaskDirty(true)
      }

      const onMaskUp = () => {
        paintingRef.current = false
        const canvas = maskCanvas.current
        if (canvas !== null) canvas.getContext('2d').beginPath()
      }

      const clearMask = () => {
        const canvas = maskCanvas.current
        if (canvas === null) return
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
        setMaskDirty(false)
      }

      /**
       * Repaint only the painted region.
       *
       * Both images are exported from the canvases at the snapped canvas size,
       * so base dims == mask dims == request dims by construction — the Host
       * checks that and the upstream API requires it.
       */
      const onInpaint = async () => {
        if (inpaintSource === '') {
          setError(t('i2iNoPick'))
          return
        }
        if (!maskDirty) {
          setError(t('inpaintNoMask'))
          return
        }
        setBusy('inpaint')
        const controller = new AbortController()
        renderAbort.current = controller
        setError('')
        setNotice('')
        try {
          const width = snapAxis(inpaintWidth, status?.width)
          const height = snapAxis(inpaintHeight, status?.height)
          const body = await api('/inpaint', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              prompt,
              width,
              height,
              inpaintStrength: Math.min(1, Math.max(0, Number(inpaintStrength) || 1)),
              base: baseCanvas.current.toDataURL('image/png'),
              mask: maskCanvas.current.toDataURL('image/png'),
              ...sideExtras()
            })
          })
          noteSeed(body)
          if (side) loadBalance()
          setNotice(`${body.files.length} · ${body.request.width}×${body.request.height} · ${body.request.model}`)
          await refresh()
        } catch (err) {
          if (err?.name === 'AbortError') setNotice(t('sideRenderCancelled'))
          else failWith(err)
        } finally {
          renderAbort.current = null
          setBusy('')
        }
      }

      /** Run the selected Director Tool on the gallery image picked above. */
      const onDirector = async () => {
        if (inpaintSource === '') {
          setError(t('i2iNoPick'))
          return
        }
        setBusy('director')
        setError('')
        setNotice('')
        try {
          const body = await api('/director', {
            method: 'POST',
            body: JSON.stringify({
              name: inpaintSource,
              type: directorType,
              ...(directorType === 'emotion' && directorEmotion.trim() !== '' ? { emotion: directorEmotion.trim() } : {})
            })
          })
          setNotice(`${body.files.length} · ${directorType}`)
          await refresh()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onProbe = async () => {
        setBusy('probe')
        setError('')
        setNotice('')
        try {
          setProbed(await api('/probe', { method: 'POST', body: '{}' }))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      // ------------------------------------------------------- artist archive --
      const [artists, setArtists] = React.useState([])
      const [artistQuery, setArtistQuery] = React.useState('')
      const [artistCount, setArtistCount] = React.useState(0)
      const [newToken, setNewToken] = React.useState('')
      const [newLabel, setNewLabel] = React.useState('')

      const loadArtists = React.useCallback(async (query, group) => {
        try {
          const body = await api(
            `/artists?limit=1000&q=${encodeURIComponent(query ?? '')}${group ? `&group=${encodeURIComponent(group)}` : ''}`
          )
          setArtists(body.artists ?? [])
          setArtistCount(body.count ?? 0)
        } catch (err) {
          setError(err.message)
        }
      }, [])

      React.useEffect(() => {
        loadArtists('')
      }, [loadArtists])

      // Searching the archive is a request that re-reads a 151 KB index on the
      // host, so it is debounced rather than fired once per keystroke.
      const artistTimer = React.useRef(null)
      const onArtistQuery = (value) => {
        setArtistQuery(value)
        if (artistTimer.current !== null) clearTimeout(artistTimer.current)
        artistTimer.current = setTimeout(() => {
          artistTimer.current = null
          loadArtists(value, artistGroup)
        }, 200)
      }
      React.useEffect(
        () => () => {
          if (artistTimer.current !== null) clearTimeout(artistTimer.current)
        },
        []
      )

      // Bring the remembered selection into view. The grid is 96 tiles tall and the
      // pick is usually well past the fold, so without this the panel looks like it
      // forgot — which is exactly how a working setting gets reported as broken.
      const selectedArtistRow = React.useRef(null)
      React.useEffect(() => {
        const node = selectedArtistRow.current
        if (node !== null && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest' })
        }
      }, [status?.artistId, artists])

      // The code-block watcher lives outside the component tree, so the toggle
      // writes through to its flag instead of recreating it. Turning it on also
      // forces a pass, so prompts already on screen render rather than waiting
      // for the transcript to change.
      React.useEffect(() => {
        const wanted = status?.autoGenerate === true
        const turningOn = wanted && !autoRender
        autoRender = wanted
        if (turningOn && typeof rescanBlocks === 'function') rescanBlocks({ autoLastOnly: true })
      }, [status])

      /** Re-read status after any mutation, so the panel never shows stale state. */
      const refreshStatus = React.useCallback(async (body) => {
        setStatus(body?.status ?? (await api('/status')))
      }, [])

      const onPickArtist = async (id) => {
        setBusy(`artist:${id}`)
        setError('')
        setNotice('')
        try {
          const patch = { artistId: id }
          await refreshStatus(await api('/config', { method: 'POST', body: JSON.stringify(patch) }))
          const picked = artists.find((row) => row.id === id) ?? (styleDetail?.id === id ? styleDetail : null)
          setNotice(id < 0 ? t('artistNonePicked') : `${t('artistPicked')}${picked ? `：${picked.name}` : ''}`)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onKeyAction = async (route, body) => {
        setBusy(`key:${route}`)
        setError('')
        setNotice('')
        try {
          await refreshStatus(await api(route, { method: 'POST', body: JSON.stringify(body ?? {}) }))
          if (route === '/keys/add') {
            setNewToken('')
            setNewLabel('')
          }
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onToggleAuto = async () => {
        setBusy('auto')
        setError('')
        try {
          await refreshStatus(
            await api('/config', { method: 'POST', body: JSON.stringify({ autoGenerate: status?.autoGenerate !== true }) })
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /**
       * Toggle the transcript scanner itself.
       *
       * The setting is persisted, and the live controller is switched in the same
       * click so the buttons appear/disappear without a reload.
       */
      const onToggleCodeButtons = async () => {
        setBusy('codeButtons')
        setError('')
        try {
          const next = status?.codeButtons !== true
          await refreshStatus(
            await api('/config', { method: 'POST', body: JSON.stringify({ codeButtons: next }) })
          )
          setBlockButtons(next)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /** 官方质量词开关。与 auto-render 同一个「读 status、写 config」的模式。 */
      const onToggleTransparent = async () => {
        setBusy('transparent')
        setError('')
        try {
          await refreshStatus(
            await api('/config', { method: 'POST', body: JSON.stringify({ transparentBackground: status?.transparentBackground !== true }) })
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      const onToggleQuality = async () => {
        setBusy('quality')
        setError('')
        try {
          await refreshStatus(
            await api('/config', { method: 'POST', body: JSON.stringify({ qualityToggle: status?.qualityToggle !== true }) })
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      // ------------------------------------------------- sidebar-only wiring --
      // Renders also arrive from the Agent and the code-block buttons, so the
      // sidebar re-reads status on a timer. Only status-derived state is touched,
      // never the form, so an edit in progress is not overwritten.
      React.useEffect(() => {
        if (!side) return undefined
        const timer = setInterval(() => {
          api('/status')
            .then((next) => {
              setStatus(next)
              setShots(next.newest ?? [])
            })
            .catch(() => {})
        }, 15000)
        return () => clearInterval(timer)
      }, [side])

      /** A 404 from a route added in this version means the host half is older. */
      const routeError = (err) => (/unknown route|HTTP 404/.test(String(err?.message)) ? t('sideNeedsRestart') : err.message)

      const loadLibInfo = React.useCallback(async () => {
        try {
          setLibInfo(await api('/libraries'))
        } catch (err) {
          setLibInfo({ error: routeError(err) })
        }
      }, [])

      React.useEffect(() => {
        if (side && sideNav === 'library' && libInfo === null) loadLibInfo()
      }, [side, sideNav, libInfo, loadLibInfo])

      const onLibSearch = async () => {
        const q = libQuery.trim()
        if (q === '') return
        setBusy('lib')
        setError('')
        try {
          const route =
            libMode === 'resolve'
              ? `/resolve?q=${encodeURIComponent(q)}&limit=12`
              : `/lookup?q=${encodeURIComponent(q)}&limit=24${libFilter ? `&library=${encodeURIComponent(libFilter)}` : ''}`
          setLibResult(await api(route))
          setLibOpen({})
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }

      const onReindex = async () => {
        setBusy('reindex')
        setError('')
        setNotice('')
        try {
          // The rebuild reads the saved directories, so unsaved edits to them go first.
          const pending = changedFields().filter((key) => key === 'libraryDir' || key === 'librarySourceDir')
          if (pending.length > 0) {
            const patch = {}
            for (const key of pending) patch[key] = form[key]
            await api('/config', { method: 'POST', body: JSON.stringify(patch) })
            setBaseline((prev) => ({ ...(prev ?? {}), ...patch }))
          }
          const body = await api('/index', { method: 'POST', body: '{}' })
          setLibInfo((prev) => ({ ...(prev ?? {}), indexed: body.indexed ?? [] }))
          setNotice(
            body.written.length > 0
              ? `${t('libReindexed')}：${body.written.map((row) => `${row.library} ${row.entries}`).join('、')}`
              : t('libReindexNone')
          )
          await refreshStatus()
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }

      const onDoctor = async () => {
        setBusy('doctor')
        setError('')
        try {
          // The doctor answers 500 when any check fails, with the report as the
          // body, so it is read directly rather than through `api`.
          const response = await fetch(`${API}/doctor`)
          setDoctor(JSON.parse(await response.text()))
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      /** Append a tag string to the shared prompt, comma-separated. */
      const appendPrompt = (text) => {
        setPrompt((prev) => {
          const base = String(prev ?? '').replace(/[\s,，]+$/, '')
          return base === '' ? text : `${base}, ${text}`
        })
      }

      /** The artist string a plain render uses: the illustration mode's, resolved. */
      const activeStyleId = Number(status?.artistId ?? -1)
      React.useEffect(() => {
        if (!side || !(activeStyleId >= 0)) {
          setStyleDetail(null)
          return undefined
        }
        let live = true
        api(`/artist?id=${activeStyleId}`)
          .then((entry) => {
            if (live) setStyleDetail(entry)
          })
          .catch(() => {
            if (live) setStyleDetail(null)
          })
        return () => {
          live = false
        }
      }, [side, activeStyleId])
      React.useEffect(() => {
        if (stylePickerOpen && styleSearch.current !== null) styleSearch.current.focus()
      }, [stylePickerOpen])
      React.useEffect(() => {
        setStylePickerOpen(false)
      }, [sideNav])

      /** Send a finished render to the edit tab as the inpaint / director base. */
      const editRender = (name) => {
        chooseInpaintImage(name)
        setEditTool('inpaint')
        setSideNav('edit')
      }

      // ------------------------------------------------------ workbench wiring --
      // The prompt itself predates the workbench; restore it from the draft once.
      React.useEffect(() => {
        // The first default ended in `transparent background`, which made every render
        // transparent; an untouched copy of it in a saved draft is replaced.
        if (side && typeof draft0.prompt === 'string' && draft0.prompt !== '') setPrompt(draft0.prompt === '1girl, solo, standing, looking at viewer, transparent background' ? '1girl, solo, standing, looking at viewer' : draft0.prompt)
      }, [])
      // Draft autosave, debounced: the whole sidebar survives a reload.
      React.useEffect(() => {
        if (!side) return undefined
        const timer = setTimeout(() => {
          writeWbDraft({
            prompt,
            nlText,
            pickedRefs,
            pickedChars,
            baseNeg,
            charRows: charRows.map(({ key: _key, ...row }) => row),
            replaceKw,
            seedText,
            callSize,
            marketPath,
            artistText
          })
        }, 400)
        return () => clearTimeout(timer)
      }, [side, prompt, nlText, pickedRefs, pickedChars, baseNeg, charRows, replaceKw, seedText, callSize, marketPath, artistText])

      const loadLlm = React.useCallback(async () => {
        try {
          setLlmInfo(await api('/llm/status'))
        } catch (err) {
          setLlmInfo({ available: false, reason: routeError(err) })
        }
      }, [])
      const loadLlmModels = React.useCallback(async () => {
        try {
          setLlmModelList((await api('/llm/models')).providers ?? [])
        } catch {
          setLlmModelList([])
        }
      }, [])
      const loadChars = React.useCallback(async () => {
        try {
          setCharDoc(await api('/characters'))
        } catch (err) {
          setCharDoc({ groups: [], characters: [], error: routeError(err) })
        }
      }, [])
      const loadMarket = React.useCallback(async () => {
        try {
          setMarket(await api('/market'))
        } catch (err) {
          setMarket({ catalog: null, error: routeError(err) })
        }
      }, [])
      const loadPresets = React.useCallback(async () => {
        try {
          const body = await api('/presets')
          setPresetData(body)
          setPresetDraft(JSON.parse(JSON.stringify(body.presets ?? {})))
        } catch (err) {
          setPresetData({ error: routeError(err) })
        }
      }, [])
      React.useEffect(() => {
        if (!side) return
        loadLlm()
        loadChars()
        loadMarket()
      }, [side])
      React.useEffect(() => {
        if (!side || sideNav !== 'settings') return
        if (llmModelList === null) loadLlmModels()
        if (presetData === null) loadPresets()
      }, [side, sideNav])
      // A saved model choice changes which model writes prompts; re-read it.
      const llmRouteKey = `${status?.llmProvider ?? ''}\u0000${status?.llmModel ?? ''}`
      const llmRouteSeen = React.useRef(null)
      React.useEffect(() => {
        if (!side || status === null) return
        if (llmRouteSeen.current !== null && llmRouteSeen.current !== llmRouteKey) loadLlm()
        llmRouteSeen.current = llmRouteKey
        // `status === null` is a dependency so the first load records the route;
        // without it the first save after opening the panel went unnoticed.
      }, [side, llmRouteKey, status === null])
      // A per-render artist text belongs to one artist string; picking another drops it.
      React.useEffect(() => {
        if (artistText !== null && artistText.forId !== activeStyleId) {
          setArtistText(null)
          setArtEditOpen(false)
        }
      }, [activeStyleId])
      // NovelAI's own img2img defaults differ for V5 (spec: 0.7 / 0 against 0.6 / 0.1).
      const i2iDefaultsSet = React.useRef(false)
      React.useEffect(() => {
        if (!side || i2iDefaultsSet.current || !status?.model) return
        i2iDefaultsSet.current = true
        if (/^nai-diffusion-5/.test(String(status.model))) {
          setStrength(0.7)
          setNoise(0)
        } else {
          setStrength(0.6)
          setNoise(0.1)
        }
      }, [side, status?.model])
      React.useEffect(() => {
        if (confirmKey === '') return undefined
        const timer = setTimeout(() => setConfirmKey(''), 3500)
        return () => clearTimeout(timer)
      }, [confirmKey])

      // ---- batch 3 wiring ----
      /** A render is in flight: the elapsed time ticks and the cancel line shows. */
      const rendering = busy === 'render' || busy === 'i2i' || busy === 'inpaint' || String(busy).startsWith('charprev:')
      React.useEffect(() => {
        if (!rendering) {
          setBusySince(0)
          return undefined
        }
        setBusySince(Date.now())
        const timer = setInterval(() => setTick((n) => n + 1), 1000)
        return () => clearInterval(timer)
      }, [rendering])
      const onCancelRender = () => renderAbort.current?.abort()

      /** Human byte size for the render progress line. */
      const formatBytes = (bytes) => {
        const value = Number(bytes)
        if (!Number.isFinite(value) || value <= 0) return '0 B'
        if (value < 1024) return `${Math.round(value)} B`
        if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
        return `${(value / (1024 * 1024)).toFixed(2)} MB`
      }

      /**
       * Poll the Host for the render's received bytes once a second.
       *
       * A slow relay answers the request and then trickles the PNG back; without
       * this the panel shows only an increasing clock, which reads as a hang.
       * @param requestId - the id sent in the render body.
       * @returns a stop function.
       */
      const watchRenderProgress = (requestId) => {
        setRenderProgress(null)
        const timer = setInterval(async () => {
          try {
            const info = await api(`/render-progress?id=${encodeURIComponent(requestId)}`)
            if (info && info.status !== 'unknown') setRenderProgress(info)
          } catch {
            // Progress is informational; a failed poll changes nothing.
          }
        }, 1000)
        return () => {
          clearInterval(timer)
          setRenderProgress(null)
        }
      }

      const loadBalance = React.useCallback(async () => {
        setBalanceBusy(true)
        try {
          setBalance(await api('/balance'))
        } catch (err) {
          setBalance({ error: routeError(err) })
        } finally {
          setBalanceBusy(false)
        }
      }, [])
      // Once per session, after the credential is known; renders refresh it again.
      const balanceAsked = React.useRef(false)
      React.useEffect(() => {
        if (!side || balanceAsked.current || status === null) return
        if (status.tokenSet !== true && Number(status.keySummary?.usableKeyCount ?? 0) === 0) return
        balanceAsked.current = true
        loadBalance()
      }, [side, status])

      /** Put a character's keyword into the description, so the writer picks its DNA. */
      const insertCharKeyword = (id) => {
        const character = (charDoc?.characters ?? []).find((row) => row.id === id)
        if (!character) return
        const keyword = (character.keywords ?? []).find((word) => !/^\/.+\/[a-z]*$/i.test(word)) ?? character.name
        const el = nlRef.current
        const text = nlText
        const start = el && Number.isInteger(el.selectionStart) ? el.selectionStart : text.length
        const end = el && Number.isInteger(el.selectionEnd) ? el.selectionEnd : start
        const before = text.slice(0, start)
        const after = text.slice(end)
        const lead = before === '' || /[\s，,、。]$/.test(before) ? '' : '、'
        setNlText(`${before}${lead}${keyword}${after}`)
        // A disabled group never matches; send that character explicitly.
        const group = (charDoc?.groups ?? []).find((row) => row.id === character.groupId)
        if (group && group.active === false && !pickedChars.includes(id)) setPickedChars((list) => [...list, id])
        setTimeout(() => {
          const node = nlRef.current
          if (node) {
            const caret = before.length + lead.length + keyword.length
            node.focus()
            node.setSelectionRange(caret, caret)
          }
        }, 0)
      }

      const loadGallery = React.useCallback(async (offset = 0, append = false) => {
        try {
          const body = await api(`/gallery?limit=60&offset=${offset}`)
          const files = Array.isArray(body.files) ? body.files : []
          setGalleryList((prev) => (append ? [...(prev ?? []), ...files] : files))
          setGalleryTotal(Number(body.total ?? files.length) || 0)
          setGalleryStats(await api('/gallery/stats').catch(() => null))
        } catch (err) {
          setError(routeError(err))
          setGalleryList((prev) => prev ?? [])
        }
      }, [])
      React.useEffect(() => {
        if (side && sideNav === 'gallery' && galleryList === null) loadGallery(0, false)
      }, [side, sideNav, galleryList])
      /** Delete renders (PNG + sidecar) and refresh every list that shows them. */
      const deleteRenders = async (names) => {
        if (names.length === 0) return
        setBusy('gallery')
        setError('')
        try {
          const body = await api('/gallery/delete', { method: 'POST', body: JSON.stringify({ names }) })
          setNotice(`${t('sideDeleted')} ${body.deleted ?? names.length}`)
          setGallerySel((list) => list.filter((name) => !names.includes(name)))
          await refresh()
          if (galleryList !== null) await loadGallery(0, false)
        } catch (err) {
          setError(routeError(err))
          throw err
        } finally {
          setBusy('')
        }
      }
      const onTrim = async (keepArg) => {
        const keep = keepArg ?? Number(trimKeep)
        if (!Number.isInteger(keep) || keep < 0) return
        setBusy('gallery')
        setError('')
        try {
          const body = await api('/gallery/trim', { method: 'POST', body: JSON.stringify({ keep }) })
          setNotice(`${t('sideDeleted')} ${body.deleted ?? 0}`)
          setTrimKeep('')
          await refresh()
          await loadGallery(0, false)
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }

      /** Render a character's reference image (its tags + optional variant) and keep it as the cover. */
      const onCharPreview = async (id, opts = {}) => {
        const controller = new AbortController()
        renderAbort.current = controller
        setBusy(`charprev:${id}`)
        setError('')
        setNotice('')
        try {
          const variant = opts.variant === undefined || opts.variant === '' ? undefined : Number(opts.variant)
          const body = await api('/characters/preview', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              id,
              ...(Number.isInteger(variant) ? { variant } : {}),
              ...(opts.useArtist === false ? { artistId: -1 } : activeStyleId >= 0 ? { artistId: activeStyleId } : {})
            })
          })
          noteSeed(body)
          await loadChars()
          await refresh()
          setNotice(t('sideCharRefDone'))
          loadBalance()
        } catch (err) {
          if (err?.name === 'AbortError') setNotice(t('sideRenderCancelled'))
          else failWith(err)
        } finally {
          renderAbort.current = null
          setBusy('')
        }
      }

      // ---- debug log wiring ----
      const loadLogs = React.useCallback(async (filter) => {
        const which = filter ?? 'all'
        const query = which === 'all' ? '' : which === 'error' ? '&level=warn,error' : `&event=${encodeURIComponent(which)}`
        setLogBusy(true)
        try {
          setLogData(await api(`/logs?limit=200${query}`))
        } catch (err) {
          setLogData({ error: routeError(err), entries: [] })
        } finally {
          setLogBusy(false)
        }
      }, [])
      React.useEffect(() => {
        if (side && sideNav === 'settings') loadLogs(logFilter)
      }, [side, sideNav, logFilter])
      /** Show an error, remembering its log entry so the flash can offer 查看日志. */
      const failWith = (err) => {
        const message = routeError(err)
        setError(message)
        setErrorLog(err?.logId ? { message, id: String(err.logId) } : null)
      }
      /** Jump to one log entry in 设置 → 日志 and open it. */
      const openLogEntry = (id) => {
        setLogFilter('all')
        setLogOpenId(String(id ?? ''))
        setSideNav('settings')
        setTimeout(() => {
          const card = logCardRef.current
          if (card) {
            card.open = true
            card.scrollIntoView({ block: 'start', behavior: 'smooth' })
          }
          document.querySelector(`[data-log-id="${CSS.escape(String(id ?? ''))}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 350)
      }
      const onClearLogs = async () => {
        setLogBusy(true)
        try {
          const body = await api('/logs/clear', { method: 'POST', body: '{}' })
          setNotice(`${t('sideLogCleared')} ${body.removed ?? ''}`)
          await loadLogs(logFilter)
        } catch (err) {
          failWith(err)
        } finally {
          setLogBusy(false)
        }
      }

      /** Two clicks to delete: the first arms the button, the second within 3.5 s acts. */
      const confirmThen = (key, action) => {
        if (confirmKey === key) {
          setConfirmKey('')
          action()
        } else setConfirmKey(key)
      }

      /** The caption the editor holds, or `null` when it is a plain prompt. */
      const sideCaption = () => {
        const rows = charRows.filter((row) => String(row.positive).trim() !== '')
        if (rows.length === 0 && String(baseNeg).trim() === '') return null
        return {
          base: prompt,
          baseNegative: baseNeg,
          characters: rows.map((row) => ({ name: row.name, positive: row.positive, negative: row.negative, center: row.center ?? null }))
        }
      }
      /** The per-render artist text, when it differs from the stored one. */
      const artistOverride = () => {
        if (artistText === null || artistText.forId !== activeStyleId || styleDetail === null) return undefined
        const pos = String(artistText.positivePrompt ?? '')
        const neg = String(artistText.negativePrompt ?? '')
        if (pos === String(styleDetail.positivePrompt ?? '') && neg === String(styleDetail.negativePrompt ?? '')) return undefined
        return { positivePrompt: pos, negativePrompt: neg }
      }
      /** Fields every sidebar render adds on top of what the page sends. */
      const sideExtras = () => {
        if (!side) return {}
        const out = { replaceCharacterKeywords: replaceKw }
        const caption = sideCaption()
        if (caption !== null) out.caption = caption
        const override = artistOverride()
        if (override !== undefined) out.artistOverride = override
        const seed = Number(seedText)
        if (seedText.trim() !== '' && Number.isInteger(seed) && seed > 0) out.seed = seed
        return out
      }
      /** Remember the seed of the newest render, for 「沿用上次种子」. */
      const noteSeed = (body) => {
        const seed = (body?.files ?? []).map((file) => file.seed).find((value) => Number.isFinite(Number(value)) && Number(value) > 0)
        if (seed !== undefined) setLastSeed(Number(seed))
      }

      /** Snap one axis to the grid NovelAI accepts. */
      const snap64 = (value) => Math.min(2048, Math.max(64, Math.round(Number(value) / 64) * 64))
      /** Put a caption from the writer, a pasted file or the viewer into the editor. */
      const applyCaption = (caption) => {
        if (caption === null || typeof caption !== 'object') return
        setPrompt(String(caption.base ?? ''))
        setBaseNeg(String(caption.baseNegative ?? ''))
        setCharRows(
          (Array.isArray(caption.characters) ? caption.characters : []).slice(0, WB_MAX_CHARACTERS).map((row) => ({
            key: wbRowKey(),
            name: String(row?.name ?? ''),
            positive: String(row?.positive ?? ''),
            negative: String(row?.negative ?? ''),
            center: row?.center && typeof row.center === 'object' ? row.center : null
          }))
        )
      }

      /** 写提示词 / 反推: the natural language (and the reference image) to a caption. */
      const onWrite = async () => {
        if (busy === 'write') return
        if (nlText.trim() === '' && refImage === null) {
          setError(t('sideWriteEmpty'))
          return
        }
        const controller = new AbortController()
        writeAbort.current = controller
        setBusy('write')
        setError('')
        setNotice('')
        try {
          const response = await fetch(`${API}/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              naturalLanguage: nlText,
              image: refImage?.dataUrl,
              references: pickedRefs.map(({ library, title, content }) => ({ library, title, content })),
              characterIds: [...new Set([...pickedChars, ...charRows.map((row) => row.charId).filter(Boolean)])],
              width: Number(callSize?.width ?? status?.width) || undefined,
              height: Number(callSize?.height ?? status?.height) || undefined
            })
          })
          const text = await response.text()
          let body = {}
          try {
            body = text === '' ? {} : JSON.parse(text)
          } catch {
            throw new Error(text.slice(0, 200))
          }
          if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), body, { status: response.status })
          setWriteFail(null)
          applyCaption(body.caption)
          const size = body.size && Number(body.size.width) > 0 && Number(body.size.height) > 0 ? { width: snap64(body.size.width), height: snap64(body.size.height) } : null
          setCallSize(size !== null && (size.width !== Number(status?.width) || size.height !== Number(status?.height)) ? size : null)
          setLastWrite({ analysis: String(body.analysis ?? ''), matched: body.matchedCharacters ?? [], route: body.route ?? null, attempts: body.attempts ?? 1, reverse: refImage !== null })
          setNotice(refImage !== null ? t('sideReverseDone') : t('sideWriteDone'))
        } catch (err) {
          if (err?.name === 'AbortError') setNotice(t('sideWriteCancelled'))
          else if (err?.code === 'WRITER_REFUSED' || err?.code === 'WORKBENCH_CAPTION_INVALID') {
            // A refusal or a bad reply has details worth reading; they go in the card
            // under the writer instead of a one-line flash.
            setLastWrite(null)
            setWriteFail({
              code: err.code,
              message: err.message,
              issues: Array.isArray(err.issues) ? err.issues : [],
              raw: String(err.raw ?? ''),
              attempts: err.attempts ?? null,
              route: err.route ?? null,
              characters: Array.isArray(err.characters) ? err.characters : [],
              logId: err.logId ?? null
            })
          } else failWith(err)
        } finally {
          writeAbort.current = null
          setBusy('')
        }
      }
      const onWriteCancel = () => writeAbort.current?.abort()

      /** Read a picked or dropped image into a data URL (≤ 8 MB, like the reference). */
      const readImageFile = (file) =>
        new Promise((resolve, reject) => {
          if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error(t('sideImageType')))
          if (file.size > 8 * 1024 * 1024) return reject(new Error(t('sideImageBig')))
          const reader = new FileReader()
          reader.onload = () => resolve({ dataUrl: String(reader.result), name: file.name || 'image.png' })
          reader.onerror = () => reject(new Error(t('failed')))
          reader.readAsDataURL(file)
        })
      const takeRefImage = async (file) => {
        try {
          setRefImage(await readImageFile(file))
        } catch (err) {
          setError(err.message)
        }
      }
      const takeDnaImage = async (file) => {
        try {
          setDnaImage(await readImageFile(file))
        } catch (err) {
          setError(err.message)
        }
      }
      /** First image in a paste or drop, if any. */
      const imageFromTransfer = (transfer) => [...(transfer?.files ?? [])].find((file) => /^image\//.test(file.type)) ?? null

      /** Send the reference image to the img2img tab as its base. */
      const refToImg2Img = async () => {
        if (refImage === null) return
        setBusy('upload')
        setError('')
        try {
          const bytes = await (await fetch(refImage.dataUrl)).arrayBuffer()
          const response = await fetch(`${API}/source-upload?name=${encodeURIComponent(refImage.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: bytes
          })
          const body = JSON.parse((await response.text()) || '{}')
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          await loadSources()
          setSourceName(body.name ?? '')
          setEditTool('i2i')
          setSideNav('edit')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      // ---- caption rows ----
      const setRow = (index, patch) => setCharRows((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
      const addRow = (row) =>
        setCharRows((rows) =>
          rows.length >= WB_MAX_CHARACTERS
            ? rows
            : [...rows, { key: wbRowKey(), name: '', positive: '', negative: '', center: null, ...(row ?? {}) }]
        )
      const removeRow = (index) => setCharRows((rows) => rows.filter((_, at) => at !== index))
      const moveRow = (index, delta) =>
        setCharRows((rows) => {
          const target = index + delta
          if (target < 0 || target >= rows.length) return rows
          const next = rows.slice()
          ;[next[index], next[target]] = [next[target], next[index]]
          return next
        })
      /** One caption row from a character's DNA, optionally with one variable feature. */
      const rowFromCharacter = (character, variantIndex) => {
        const variant = Number.isInteger(variantIndex) ? character.variableFeatures?.[variantIndex] : null
        return {
          charId: character.id,
          name: variant ? `${character.name} · ${variant.name}` : character.name,
          // Only the tags: a DNA written for the prompt writer can carry a Chinese description.
          positive: [wbPromptTags(character.fixedFeatures) || character.fixedFeatures, wbPromptTags(variant?.prompt)].filter((part) => String(part ?? '').trim() !== '').join(', '),
          negative: String(character.negative ?? '')
        }
      }
      const onClearCaption = () => {
        setPrompt('')
        setBaseNeg('')
        setCharRows([])
        setCallSize(null)
        setLastWrite(null)
      }

      // ---- picked references and characters ----
      const refKey = (hit) => `${hit.library}#${hit.uid ?? hit.title}`
      const togglePickedRef = (hit) =>
        setPickedRefs((list) =>
          list.some((row) => row.key === refKey(hit))
            ? list.filter((row) => row.key !== refKey(hit))
            : [...list, { key: refKey(hit), library: hit.library, title: hit.title || '—', content: String(hit.content ?? '').slice(0, 4000) }]
        )
      const togglePickedChar = (id) => setPickedChars((list) => (list.includes(id) ? list.filter((row) => row !== id) : [...list, id]))

      // ---- character library ----
      const charCall = async (route, payload, done) => {
        setBusy(`char:${route}`)
        setError('')
        try {
          const body = await api(route, { method: 'POST', body: JSON.stringify(payload) })
          const doc = body?.doc ?? (Array.isArray(body?.characters) ? body : null)
          if (doc) setCharDoc(doc)
          else await loadChars()
          if (typeof done === 'function') done(body)
          return body
        } catch (err) {
          setError(routeError(err))
          return null
        } finally {
          setBusy('')
        }
      }
      const newCharDraft = (groupId) => ({
        id: undefined,
        groupId: groupId ?? charDoc?.groups?.[0]?.id ?? '',
        name: '',
        keywordsText: '',
        fixedFeatures: '',
        variableFeatures: [],
        negative: '',
        matchOverrides: null
      })
      const editCharacter = (character) => {
        setAiEditText('')
        setAiEditNote('')
        setCharEdit({ ...character, keywordsText: (character.keywords ?? []).join(', '), variableFeatures: (character.variableFeatures ?? []).map((row) => ({ ...row })) })
      }
      const onSaveCharacter = () => {
        if (charEdit === null) return
        if (String(charEdit.name ?? '').trim() === '') {
          setError(t('sideCharNameNeeded'))
          return
        }
        const { keywordsText, notes: _notes, ...rest } = charEdit
        charCall('/characters/save', { character: { ...rest, keywords: keywordsText } }, () => {
          setCharEdit(null)
          setAiEditText('')
          setAiEditNote('')
          setNotice(t('sideCharSaved'))
        })
      }
      const onDnaFromImage = async () => {
        if (dnaImage === null) {
          setError(t('sideDnaNoImage'))
          return
        }
        setBusy('dna')
        setError('')
        try {
          const body = await api('/characters/from-image', { method: 'POST', body: JSON.stringify({ image: dnaImage.dataUrl, hint: dnaHint }) })
          const draft = body.draft ?? {}
          setCharEdit({
            ...newCharDraft(),
            name: String(draft.name ?? ''),
            keywordsText: (Array.isArray(draft.keywords) ? draft.keywords : []).join(', '),
            fixedFeatures: String(draft.fixedFeatures ?? ''),
            variableFeatures: Array.isArray(draft.variableFeatures) ? draft.variableFeatures.map((row) => ({ name: String(row.name ?? ''), prompt: String(row.prompt ?? '') })) : [],
            negative: String(draft.negative ?? ''),
            notes: String(draft.notes ?? '')
          })
          setDnaOpen(false)
          setAiEditText('')
          setAiEditNote('')
          setNotice(t('sideDnaDone'))
        } catch (err) {
          failWith(err)
        } finally {
          setBusy('')
        }
      }
      /**
       * 「用提示词改特征」: one model call rewrites the character from the text in
       * the box, then fills the edit form. Nothing is saved here — the form's own
       * 保存 is still the only write, so the user can read the rewrite first.
       */
      const onAiEditCharacter = async () => {
        if (charEdit === null) return
        const instruction = String(aiEditText).trim()
        if (instruction === '') {
          setError(t('sideCharAiEmpty'))
          return
        }
        setBusy('aiedit')
        setError('')
        setAiEditNote('')
        try {
          const body = await api('/characters/ai-edit', {
            method: 'POST',
            body: JSON.stringify({
              id: charEdit.id ?? null,
              instruction,
              // The unsaved form is what the user is looking at, so that is what
              // the model rewrites; the stored record is only the fallback.
              character: {
                name: charEdit.name,
                keywords: charEdit.keywordsText,
                fixedFeatures: charEdit.fixedFeatures,
                variableFeatures: charEdit.variableFeatures ?? [],
                negative: charEdit.negative ?? ''
              }
            })
          })
          const draft = body.draft ?? {}
          setCharEdit((current) =>
            current === null
              ? current
              : {
                  ...current,
                  name: String(draft.name ?? current.name ?? ''),
                  keywordsText: Array.isArray(draft.keywords) ? draft.keywords.join(', ') : current.keywordsText,
                  fixedFeatures: String(draft.fixedFeatures ?? current.fixedFeatures ?? ''),
                  variableFeatures: Array.isArray(draft.variableFeatures)
                    ? draft.variableFeatures.map((row) => ({ name: String(row.name ?? ''), prompt: String(row.prompt ?? '') }))
                    : current.variableFeatures,
                  negative: String(draft.negative ?? current.negative ?? '')
                }
          )
          const model = body.route && body.route.provider ? `${body.route.provider}/${body.route.model}` : ''
          setAiEditNote([String(body.analysis ?? '').trim(), model].filter((part) => part !== '').join(' · ') || t('sideCharAiDone'))
          setNotice(t('sideCharAiDone'))
        } catch (err) {
          failWith(err)
        } finally {
          setBusy('')
        }
      }
      const onCharImport = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        try {
          const payload = JSON.parse(await file.text())
          await charCall('/characters/import', { payload, onDuplicate: 'overwrite' }, (body) =>
            setNotice(`${t('sideCharImported')} ${body?.characters ?? ''}`)
          )
        } catch (err) {
          setError(err instanceof SyntaxError ? t('sideJsonBad') : err.message)
        }
      }

      // ---- tag market ----
      const onMarketImport = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setBusy('market')
        setError('')
        try {
          const catalog = JSON.parse(await file.text())
          const body = await api('/market/import', { method: 'POST', body: JSON.stringify({ catalog }) })
          await loadMarket()
          setMarketPath([])
          setNotice(`${t('sideMarketImported')} ${body.count ?? ''}`)
        } catch (err) {
          setError(err instanceof SyntaxError ? t('sideJsonBad') : routeError(err))
        } finally {
          setBusy('')
        }
      }
      /** The text of one caption field and its setter. */
      const captionField = (field) => {
        if (field === 'base') return [prompt, setPrompt]
        if (field === 'baseNeg') return [baseNeg, setBaseNeg]
        const match = /^row(\d+)(pos|neg)$/.exec(field)
        if (match) {
          const index = Number(match[1])
          const key = match[2] === 'pos' ? 'positive' : 'negative'
          const row = charRows[index]
          if (row) return [row[key], (value) => setRow(index, { [key]: typeof value === 'function' ? value(row[key]) : value })]
        }
        return [prompt, setPrompt]
      }
      const tagPattern = (value) => new RegExp(`(^|,\\s*)${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s*(,|$))`)
      /** Whether a tag is already in any caption field. */
      const tagInCaption = (value) =>
        [prompt, baseNeg, ...charRows.flatMap((row) => [row.positive, row.negative])].some((text) => tagPattern(value).test(String(text ?? '')))
      /** Insert a tag at the caret of the last focused caption field, or take it out again. */
      const toggleTag = (value) => {
        const clean = String(value ?? '').trim()
        if (clean === '') return
        if (tagInCaption(clean)) {
          for (const field of ['base', 'baseNeg', ...charRows.flatMap((_, index) => [`row${index}pos`, `row${index}neg`])]) {
            const [text, setText] = captionField(field)
            if (tagPattern(clean).test(String(text ?? ''))) {
              setText(String(text).replace(tagPattern(clean), (_m, lead) => (lead === '' ? '' : '')).replace(/^\s*,\s*/, '').replace(/,\s*,/g, ','))
              return
            }
          }
          return
        }
        const focus = capFocus.current
        const [text, setText] = captionField(focus.field)
        const body = String(text ?? '')
        const at = Number.isInteger(focus.start) ? Math.min(body.length, focus.start) : body.length
        const until = Number.isInteger(focus.end) ? Math.min(body.length, Math.max(at, focus.end)) : at
        const before = body.slice(0, at)
        const after = body.slice(until)
        const lead = before === '' || /[\s,，]$/.test(before) ? '' : ', '
        const tail = after === '' || /^[\s,，]/.test(after) ? '' : ', '
        setText(`${before}${lead}${clean}${tail}${after}`)
        const caret = before.length + lead.length + clean.length + tail.length
        capFocus.current = { ...focus, start: caret, end: caret }
      }
      /** Remember where the caret was in a caption field, for the tag market. */
      const trackCaret = (field) => (event) => {
        capFocus.current = { field, start: event.target.selectionStart, end: event.target.selectionEnd }
      }

      // ---- per-render artist text ----
      const openArtistText = () => {
        if (styleDetail === null || !(activeStyleId >= 0)) return
        if (artistText === null || artistText.forId !== activeStyleId) {
          setArtistText({ forId: activeStyleId, name: String(styleDetail.name ?? ''), positivePrompt: String(styleDetail.positivePrompt ?? ''), negativePrompt: String(styleDetail.negativePrompt ?? '') })
        }
        setArtEditOpen((open) => !open)
      }
      const refreshStyle = async (id) => {
        await refreshStatus()
        loadArtists(artistQuery, artistGroup)
        try {
          setStyleDetail(await api(`/artist?id=${id}`))
        } catch {
          /* the status refresh will settle it */
        }
      }
      const onArtistSave = async (asNew) => {
        if (artistText === null) return
        setBusy('artist-save')
        setError('')
        try {
          const name = String(artistText.name ?? '').trim() || String(styleDetail?.name ?? '')
          const body = await api('/artists/user/save', {
            method: 'POST',
            body: JSON.stringify({
              ...(asNew ? {} : { id: activeStyleId }),
              name: asNew && name === String(styleDetail?.name ?? '') ? `${name} · ${t('sideArtCopy')}` : name,
              positivePrompt: artistText.positivePrompt,
              negativePrompt: artistText.negativePrompt
            })
          })
          setArtistText(null)
          setArtEditOpen(false)
          if (asNew && Number.isFinite(Number(body.id))) await onPickArtist(Number(body.id))
          await refreshStyle(asNew ? Number(body.id) : activeStyleId)
          setNotice(asNew ? t('sideArtCreated') : t('sideArtSaved'))
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }
      const onArtistCover = async (name) => {
        if (!(activeStyleId >= 0)) throw new Error(t('sideArtNone'))
        await api('/artists/user/cover', { method: 'POST', body: JSON.stringify({ id: activeStyleId, from: name }) })
        await refreshStyle(activeStyleId)
        setNotice(t('sideArtCoverDone'))
      }
      const onArtistRevert = async () => {
        setBusy('artist-save')
        setError('')
        try {
          await api('/artists/user/delete', { method: 'POST', body: JSON.stringify({ id: activeStyleId }) })
          setArtistText(null)
          setArtEditOpen(false)
          if (styleDetail?.user) await onPickArtist(-1)
          await refreshStyle(activeStyleId)
          setNotice(styleDetail?.user ? t('sideArtDeleted') : t('sideArtReverted'))
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }

      // ---- viewer ----
      /** Open the shared viewer on pictures that are not renders (artist previews, character covers). */
      const openPictures = (entries, at) => {
        if (entries.length === 0) return
        openWbViewer({ entries, index: Math.max(0, at), t })
      }
      /** Every artist string that has a preview, so ←/→ browses styles while looking. */
      const openArtistPreview = (id) => {
        const rows = artists.filter((row) => row.hasThumb || row.hasImage || row.hasCover)
        const at = rows.findIndex((row) => row.id === id)
        openPictures(
          rows.map((row) => ({ name: row.name, kind: 'artist', src: `${API}/artist-image?id=${row.id}${row.coverVersion ? `&v=${encodeURIComponent(row.coverVersion)}` : ''}` })),
          at < 0 ? 0 : at
        )
      }
      /** Every character that has a cover, for the same reason. */
      const openCharacterPreview = (id) => {
        const rows = (charDoc?.characters ?? []).filter((row) => row.hasCover)
        const at = rows.findIndex((row) => row.id === id)
        openPictures(
          rows.map((row) => ({ name: row.name, kind: 'character', src: `${API}/character-image?id=${encodeURIComponent(row.id)}&v=${encodeURIComponent(row.coverVersion ?? '')}` })),
          at < 0 ? 0 : at
        )
      }
      const openViewer = async (name, preset) => {
        let files = preset ?? shots
        if (!preset) try {
          const body = await api('/gallery?limit=120&offset=0')
          if (Array.isArray(body.files) && body.files.length > 0) files = body.files
        } catch {
          /* the newest list is enough */
        }
        const index = Math.max(0, files.findIndex((file) => file.name === name))
        openWbViewer({
          entries: files.map((file) => ({ name: file.name, kind: 'gallery', src: `${API}/file?name=${encodeURIComponent(file.name)}` })),
          index,
          t,
          onEdit: (file) => editRender(file),
          onCover: activeStyleId >= 0 ? onArtistCover : null,
          onDelete: (file) => deleteRenders([file]),
          onLoad: (meta) => {
            const request = meta?.request ?? {}
            if (request.caption && typeof request.caption === 'object') applyCaption(request.caption)
            else applyCaption({ base: String(request.userPrompt ?? request.prompt ?? ''), baseNegative: '', characters: [] })
            if (typeof request.replaceCharacterKeywords === 'boolean') setReplaceKw(request.replaceCharacterKeywords)
            const seed = (meta?.files ?? []).find((row) => row.name === name)?.seed ?? meta?.files?.[0]?.seed
            if (Number(seed) > 0) setLastSeed(Number(seed))
            setSideNav('create')
            setNotice(t('sideViewerLoaded'))
          }
        })
      }

      // ---- prompt presets ----
      const onPresetSave = async () => {
        setBusy('presets')
        setError('')
        try {
          const body = await api('/presets', { method: 'POST', body: JSON.stringify(presetDraft ?? {}) })
          setPresetData(body)
          setPresetDraft(JSON.parse(JSON.stringify(body.presets ?? {})))
          setNotice(t('saved'))
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }
      const onPresetReset = async (name) => {
        setBusy('presets')
        try {
          const body = await api('/presets/reset', { method: 'POST', body: JSON.stringify({ name }) })
          setPresetData(body)
          setPresetDraft(JSON.parse(JSON.stringify(body.presets ?? {})))
        } catch (err) {
          setError(routeError(err))
        } finally {
          setBusy('')
        }
      }

      // The success line fades on its own in the sidebar; errors stay until dismissed.
      React.useEffect(() => {
        if (!side || notice === '') return undefined
        const timer = setTimeout(() => setNotice(''), 3200)
        return () => clearTimeout(timer)
      }, [side, notice])

      if (form === null) {
        return h('div', { style: { padding: 24, fontSize: 13 } }, error || t('loading'))
      }

      const heavy =
        (Number(form.width) * Number(form.height)) / (832 * 1216) * (Number(form.steps) / 28) > HEAVY_UNITS

      const numericField = (key, title, step, max) =>
        h(
          'div',
          { key, style: cell(0.5) },
          h('label', { style: label }, title),
          h('input', {
            type: 'number',
            step: step ?? 1,
            // `max` is a hint for the spinner, not a constraint: the field stays
            // hand-editable because NovelAI may add a preset beyond the five known.
            ...(max === undefined ? {} : { max }),
            style: input,
            value: form[key] ?? '',
            onChange: set(key)
          })
        )

      const textField = (key, title, placeholder) =>
        h(
          'div',
          { key, style: cell(2) },
          h('label', { style: label }, title),
          h('input', { style: input, placeholder, value: form[key] ?? '', onChange: set(key) })
        )

      /**
       * A label + hint, for explaining a field whose effect is not obvious.
       *
       * Chosen over a fixed-choice control on purpose: these fields stay
       * hand-editable, so the hint names the values instead of constraining them.
       */
      const hintField = (key, title, hint) =>
        h(
          'div',
          { key, style: { ...label, flex: '1 1 100%', marginTop: 4 } },
          h('span', { style: { fontWeight: 600 } }, `${title}：`),
          hint
        )

      // The two picker dialogs are shared by the page and the sidebar layouts.
      const sourcePickerModal =
      pickerOpen
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483000,
                background: 'rgba(0, 0, 0, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24
              },
              onClick: () => setPickerOpen(false)
            },
            h(
              'div',
              {
                style: {
                  width: 'min(780px, 94vw)',
                  maxHeight: '78vh',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: token('--dsw-radius-lg', '10px'),
                  border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
                  background: token('--dsw-alias-bg-overlay', '#fff'),
                  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)'
                },
                onClick: (event) => event.stopPropagation()
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderBottom: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`
                  }
                },
                h('div', { style: { fontWeight: 600 } }, t('i2iPickerTitle')),
                h('div', { style: { ...label, flex: 1 } }, t('i2iPickerHint')),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: loadMoreSources, disabled: moreLoading || sources.length >= sourceTotal },
                  `${t('loadMore')} (${sources.length}/${sourceTotal})`
                ),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: () => setPickerOpen(false) },
                  t('i2iClose')
                )
              ),
              sources.length === 0
                ? h('div', { style: { padding: 16 } }, t('i2iNoSources'))
                : h(
                    'div',
                    {
                      style: {
                        padding: 12,
                        overflowY: 'auto',
                        // The modal is a flex column with `overflow: hidden`; a
                        // grid that does not claim the remaining height just
                        // overflows and gets clipped, which looks like only the
                        // newest few images exist.
                        flex: '1 1 auto',
                        minHeight: 0,
                        display: 'grid',
                        gap: 10,
                        gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))'
                      }
                    },
                    sources.map((file) =>
                      h(
                        'button',
                        {
                          key: file.name,
                          type: 'button',
                          onClick: () => {
                            // One selection at a time: the new name replaces
                            // whatever was held before, so nothing stale can
                            // be rendered later.
                            setSourceName(file.name)
                            setPickerOpen(false)
                          },
                          style: {
                            padding: 6,
                            cursor: 'pointer',
                            textAlign: 'left',
                            borderRadius: token('--dsw-radius-md', '6px'),
                            border: `2px solid ${
                              file.name === sourceName
                                ? token('--dsw-alias-accent', '#2d6cff')
                                : token('--dsw-alias-border-l1', '#e6e6ea')
                            }`,
                            background: 'transparent'
                          }
                        },
                        h('img', {
                          src: `${API}/source-file?name=${encodeURIComponent(file.name)}`,
                          alt: file.name,
                          loading: 'lazy',
                          style: {
                            display: 'block',
                            width: '100%',
                            height: 120,
                            objectFit: 'contain',
                            borderRadius: 4,
                            background: 'repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
                          }
                        }),
                        h(
                          'div',
                          { style: { ...label, marginTop: 4, wordBreak: 'break-all' } },
                          `${file.name} (${Math.round(file.bytes / 1024)}KB)`
                        )
                      )
                    )
                  )
            )
          )
        : null

      const galleryPickerModal =
      inpaintPickerOpen
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483000,
                background: 'rgba(0, 0, 0, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24
              },
              onClick: () => setInpaintPickerOpen(false)
            },
            h(
              'div',
              {
                style: {
                  width: 'min(780px, 94vw)',
                  maxHeight: '78vh',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: token('--dsw-radius-lg', '10px'),
                  border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
                  background: token('--dsw-alias-bg-overlay', '#fff'),
                  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)'
                },
                onClick: (event) => event.stopPropagation()
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderBottom: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`
                  }
                },
                h('div', { style: { fontWeight: 600 } }, t('inpaintPick')),
                h('div', { style: { ...label, flex: 1 } }, t('inpaintPickHint')),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: loadMoreInpaint, disabled: moreLoading || inpaintShots.length >= inpaintTotal },
                  `${t('loadMore')} (${inpaintShots.length}/${inpaintTotal})`
                ),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: () => setInpaintPickerOpen(false) },
                  t('i2iClose')
                )
              ),
              inpaintShots.length === 0
                ? h('div', { style: { padding: 16 } }, t('galleryEmpty'))
                : h(
                    'div',
                    {
                      style: {
                        padding: 12,
                        overflowY: 'auto',
                        // The modal is a flex column with `overflow: hidden`; a
                        // grid that does not claim the remaining height just
                        // overflows and gets clipped, which looks like only the
                        // newest few images exist.
                        flex: '1 1 auto',
                        minHeight: 0,
                        display: 'grid',
                        gap: 10,
                        gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))'
                      }
                    },
                    inpaintShots.map((file) =>
                      h(
                        'button',
                        {
                          key: file.name,
                          type: 'button',
                          onClick: () => chooseInpaintImage(file.name),
                          style: {
                            padding: 6,
                            cursor: 'pointer',
                            textAlign: 'left',
                            borderRadius: token('--dsw-radius-md', '6px'),
                            border: `2px solid ${
                              file.name === inpaintSource
                                ? token('--dsw-alias-accent', '#2d6cff')
                                : token('--dsw-alias-border-l1', '#e6e6ea')
                            }`,
                            background: 'transparent'
                          }
                        },
                        h('img', {
                          src: `${API}/file?name=${encodeURIComponent(file.name)}`,
                          alt: file.name,
                          loading: 'lazy',
                          style: {
                            display: 'block',
                            width: '100%',
                            height: 120,
                            objectFit: 'contain',
                            borderRadius: 4,
                            background: 'repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
                          }
                        }),
                        h('div', { style: { ...label, marginTop: 4, wordBreak: 'break-all' } }, file.name)
                      )
                    )
                  )
            )
          )
        : null

      // ======================================================= sidebar layout ==
      // The same state and handlers as the page below, laid out for a narrow
      // column: four tabs (create / edit / library / settings), cards that keep
      // a one-line summary of their values when collapsed, and one save bar for
      // every form field.
      if (side) {
        const credentialOk = status?.tokenSet === true || Number(status?.keySummary?.usableKeyCount ?? 0) > 0
        const keySum = status?.keySummary ?? null
        const dirty = changedFields().length > 0 || Boolean(form.token)
        const sw = Number(status?.width) || 0
        const shh = Number(status?.height) || 0
        const freeBand = sw * shh <= 1048576 && Number(status?.steps ?? 28) <= 28
        const variantCap = Math.max(1, Math.min(8, Number(status?.maxImagesPerCall) || 4))
        const ucNames = [t('uc0'), t('uc1'), t('uc2'), t('uc3'), t('uc4')]
        const onOff = (flag) => (flag ? t('sideOn') : t('sideOff'))

        const btn = (text, onClick, opts = {}) =>
          h(
            'button',
            {
              key: opts.key,
              type: 'button',
              className: 'nai-s-btn',
              'data-kind': opts.kind,
              'data-size': opts.size,
              'aria-pressed': opts.pressed,
              disabled: opts.disabled === true,
              title: opts.title,
              onClick
            },
            text
          )
        const field = (key, title, opts = {}) =>
          h(
            'label',
            { className: `nai-s-field${opts.wide ? ' nai-s-wide' : ''}` },
            h('span', { className: 'nai-s-label' }, title),
            h('input', {
              className: `nai-s-in${opts.mono ? ' nai-s-mono' : ''}`,
              type: opts.type ?? 'text',
              step: opts.step,
              min: opts.min,
              max: opts.max,
              list: opts.list,
              placeholder: opts.placeholder,
              spellCheck: false,
              value: form[key] ?? '',
              onChange: set(key)
            })
          )
        const panelCard = (title, summary, open, ...body) =>
          h(
            'details',
            { className: 'nai-s-card', open: open ? true : undefined },
            h(
              'summary',
              null,
              h('span', { className: 'nai-s-card-title' }, title),
              summary ? h('span', { className: 'nai-s-card-sum nai-s-mono' }, summary) : null
            ),
            h('div', { className: 'nai-s-card-body' }, ...body)
          )
        const switchRow = (name, hint, on, onToggle, isBusy) =>
          h(
            'div',
            { className: 'nai-s-switch' },
            h('div', null, h('div', { className: 'nai-s-switch-name' }, name), hint ? h('p', { className: 'nai-s-hint' }, hint) : null),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': on ? 'true' : 'false',
              'aria-label': name,
              className: 'nai-s-switch-btn',
              disabled: isBusy,
              onClick: onToggle
            })
          )
        const fileUrl = (name) => `${API}/file?name=${encodeURIComponent(name)}`
        const shot = (file, hero) =>
          h(
            'div',
            { key: file.name, className: 'nai-s-shot', 'data-hero': hero ? '1' : undefined },
            h(
              'a',
              {
                href: fileUrl(file.name),
                target: '_blank',
                rel: 'noreferrer',
                title: file.name,
                style: { display: 'block', height: '100%' },
                // A plain click opens the in-app viewer; modified clicks keep the browser's own behaviour.
                onClick: (event) => {
                  if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    event.preventDefault()
                    openViewer(file.name)
                  }
                }
              },
              h('img', {
                src: fileUrl(file.name),
                alt: file.name,
                loading: 'lazy',
                [IMG_ATTR]: '1',
                'data-nai-name': file.name,
                'data-nai-kind': 'gallery'
              })
            ),
            h(
              'div',
              { className: 'nai-s-shot-act' },
              btn(t('sideEditThis'), () => editRender(file.name), { size: 's' }),
              btn(confirmKey === `shot:${file.name}` ? t('sideConfirmDelete') : '🗑', () => confirmThen(`shot:${file.name}`, () => deleteRenders([file.name]).catch(() => {})), {
                size: 's',
                kind: 'danger',
                title: t('sideDeleteRender'),
                disabled: busy === 'gallery'
              })
            )
          )
        const seg = (value, onPick, options) =>
          h(
            'div',
            { className: 'nai-s-seg', role: 'group' },
            options.map(([key, text]) =>
              h('button', { key, type: 'button', 'aria-pressed': value === key ? 'true' : 'false', onClick: () => onPick(key) }, text)
            )
          )
        const pickBox = (src, name, ...actions) =>
          h(
            'div',
            { className: 'nai-s-pick' },
            h('div', { className: 'nai-s-pick-thumb' }, src ? h('img', { src, alt: '' }) : null),
            h(
              'div',
              { className: 'nai-s-pick-body' },
              h('div', { className: 'nai-s-pick-name' }, name),
              h('div', { className: 'nai-s-row' }, ...actions)
            )
          )
        const promptBox = (rows) =>
          h('textarea', {
            className: 'nai-s-in nai-s-mono',
            rows,
            spellCheck: false,
            value: prompt,
            onChange: (event) => setPrompt(event.target.value)
          })

        // ------------------------------------------------------- style bar --
        // `v` busts the browser cache when a cover is replaced (the archive pictures cache for a day).
        const artistThumb = (id, version) => `${API}/artist-image?id=${id}&thumb=1${version ? `&v=${encodeURIComponent(version)}` : ''}`
        const groups = status?.artistGroups ?? []
        const artistTotal = artistCount || status?.artistCount || 0
        // Entries without a preview get a tinted tile with a short label. A whole
        // archive often shares a naming prefix (every 「梦…」), so that prefix is
        // dropped per group, otherwise all of its tiles would read the same.
        // Naming families inside an archive (「梦…」, 「W.O…」): a prefix counts when
        // at least 5 names start with it and extending it keeps nearly all of them.
        const familyPrefixes = new Set()
        const familyCounts = new Map()
        {
          const counts = new Map()
          for (const row of artists) {
            const name = String(row.name ?? '')
            for (let n = 1; n <= Math.min(4, name.length - 1); n += 1) counts.set(name.slice(0, n), (counts.get(name.slice(0, n)) ?? 0) + 1)
          }
          for (const [prefix, count] of counts) {
            if (count < 5) continue
            familyPrefixes.add(prefix)
            familyCounts.set(prefix, count)
          }
        }
        /** A stable tint plus a few characters that tell entries apart. */
        const swatch = (name) => {
          const full = String(name ?? '').trim()
          let hash = 0
          for (const char of full) hash = (hash * 31 + char.codePointAt(0)) >>> 0
          // The family is the run of prefixes that keep (nearly) all of its members:
          // 「W」「W.」「W.O」 → 「W.O」, but 「梦」 → 「梦清线」 narrows to a few, so 「梦」.
          let prefix = ''
          for (let n = 1; n <= Math.min(4, full.length - 1); n += 1) {
            const candidate = full.slice(0, n)
            if (!familyPrefixes.has(candidate)) {
              if (prefix !== '') break
              continue
            }
            if (prefix !== '' && familyCounts.get(candidate) < familyCounts.get(prefix) * 0.8) break
            prefix = candidate
          }
          const rest = full.slice(prefix.length)
          const head = rest.split(/[-－—（(\s/·]/).find((part) => part !== '') ?? rest
          return h('span', { className: 'nai-s-swatch', style: { '--hue': hash % 360 } }, Array.from(head).slice(0, 4).join(''))
        }
        const pickGroup = (group) => {
          setArtistGroup(group)
          loadArtists(artistQuery, group)
        }
        const groupChips = () =>
          groups.length > 1
            ? h(
                'div',
                { className: 'nai-s-chips' },
                h('button', { type: 'button', className: 'nai-s-chip', 'aria-pressed': artistGroup === '' ? 'true' : 'false', onClick: () => pickGroup('') }, t('sideStyleAll'), h('span', { className: 'nai-s-chip-n' }, String(artistTotal))),
                groups.map((row) =>
                  h(
                    'button',
                    {
                      key: row.group,
                      type: 'button',
                      className: 'nai-s-chip',
                      title: row.group,
                      'aria-pressed': artistGroup === row.group ? 'true' : 'false',
                      onClick: () => pickGroup(row.group)
                    },
                    row.group,
                    h('span', { className: 'nai-s-chip-n' }, String(row.count))
                  )
                )
              )
            : null
        const styleName = styleDetail?.name ?? status?.artistName ?? ''
        const styleOn = activeStyleId >= 0
        const styleArea = (where) =>
          h(
            'div',
            { className: 'nai-s-style', 'data-open': stylePickerOpen && sideNav === where ? '1' : undefined },
            h(
              'div',
              { className: 'nai-s-stylebar', 'data-empty': styleOn ? undefined : '1' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'nai-s-stylebar-art',
                  'aria-label': t('sideStyleChange'),
                  onClick: () => setStylePickerOpen((open) => !open)
                },
                styleOn ? (styleDetail?.id === activeStyleId && (styleDetail?.thumb || styleDetail?.image || styleDetail?.hasCover) ? h('img', { src: artistThumb(activeStyleId, styleDetail?.coverVersion), alt: '' }) : swatch(styleName, styleDetail?.group)) : h('span', { className: 'nai-s-swatch', 'data-blank': '1' }, '∅')
              ),
              h(
                'div',
                { className: 'nai-s-stylebar-text' },
                h(
                  'span',
                  { className: 'nai-s-stylebar-label' },
                  `${t('sideStyle')}${styleOn ? ` · #${activeStyleId}` : ''}`,
                  styleOn && artistOverride() !== undefined
                    ? h('span', { className: 'nai-s-badge', style: { marginLeft: 6 } }, t('sideArtOverrideBadge'))
                    : styleOn && (styleDetail?.edited || styleDetail?.user)
                      ? h('span', { className: 'nai-s-badge', style: { marginLeft: 6 } }, styleDetail?.user ? t('sideArtMine') : t('sideArtEdited'))
                      : null
                ),
                h('span', { className: 'nai-s-stylebar-name' }, styleOn ? styleName || `#${activeStyleId}` : t('sideStyleNone')),
                styleOn && styleDetail?.positivePrompt
                  ? h('span', { className: 'nai-s-stylebar-tags nai-s-mono', title: styleDetail.positivePrompt }, styleDetail.positivePrompt.replace(/\s+/g, ' '))
                  : null
              ),
              h(
                'div',
                { className: 'nai-s-stylebar-acts' },
                styleOn && styleDetail
                  ? btn(t('sideArtText'), openArtistText, { kind: 'ghost', size: 's', pressed: artEditOpen && sideNav === where ? 'true' : 'false', title: t('sideArtTextHint') })
                  : null,
                styleOn ? btn(t('sideStyleRemove'), () => onPickArtist(-1), { kind: 'ghost', size: 's', disabled: busy === 'artist:-1' }) : null,
                btn(
                  stylePickerOpen && sideNav === where ? t('sideStyleClose') : styleOn ? t('sideStyleChange') : t('sideStyleChoose'),
                  () => setStylePickerOpen((open) => !open),
                  { size: 's', kind: styleOn || (stylePickerOpen && sideNav === where) ? undefined : 'primary', pressed: stylePickerOpen && sideNav === where ? 'true' : 'false' }
                )
              )
            ),
            styleOn && artEditOpen && artistText !== null && sideNav === where
              ? h(
                  'div',
                  { className: 'nai-s-artedit' },
                  h('p', { className: 'nai-s-hint' }, t('sideArtTextHint')),
                  h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideArtName')),
                    h('input', { className: 'nai-s-in', value: artistText.name ?? '', onChange: (event) => setArtistText({ ...artistText, name: event.target.value }) })
                  ),
                  h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideArtPositive')),
                    h('textarea', { className: 'nai-s-in nai-s-mono', rows: 4, spellCheck: false, value: artistText.positivePrompt, onChange: (event) => setArtistText({ ...artistText, positivePrompt: event.target.value }) })
                  ),
                  h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideArtNegative')),
                    h('textarea', { className: 'nai-s-in nai-s-mono', rows: 3, spellCheck: false, value: artistText.negativePrompt, onChange: (event) => setArtistText({ ...artistText, negativePrompt: event.target.value }) })
                  ),
                  h(
                    'div',
                    { className: 'nai-s-row' },
                    btn(t('sideArtSave'), () => onArtistSave(false), { kind: 'primary', size: 's', disabled: busy === 'artist-save' }),
                    btn(t('sideArtSaveNew'), () => onArtistSave(true), { size: 's', disabled: busy === 'artist-save' }),
                    shots[0] ? btn(t('sideArtCover'), () => onArtistCover(shots[0].name).catch((err) => setError(routeError(err))), { kind: 'ghost', size: 's', title: t('sideArtCoverHint') }) : null,
                    h('span', { className: 'nai-s-sp' }),
                    btn(t('sideArtDiscard'), () => {
                      setArtistText(null)
                      setArtEditOpen(false)
                    }, { kind: 'ghost', size: 's' }),
                    styleDetail?.edited || styleDetail?.user
                      ? btn(
                          confirmKey === `art:${activeStyleId}` ? t('sideConfirmDelete') : styleDetail?.user ? t('sideArtDelete') : t('sideArtRevert'),
                          () => confirmThen(`art:${activeStyleId}`, onArtistRevert),
                          { kind: 'danger', size: 's', disabled: busy === 'artist-save' }
                        )
                      : null
                  )
                )
              : null,
            stylePickerOpen && sideNav === where
              ? h(
                  'div',
                  {
                    className: 'nai-s-stylepick',
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') setStylePickerOpen(false)
                    }
                  },
                  h('input', {
                    ref: styleSearch,
                    className: 'nai-s-in',
                    placeholder: t('sideStyleSearch'),
                    value: artistQuery,
                    onChange: (event) => onArtistQuery(event.target.value)
                  }),
                  groupChips(),
                  artistTotal === 0
                    ? h('div', { className: 'nai-s-stack' }, h('p', { className: 'nai-s-hint' }, t('sideArtistEmpty')), h('code', { className: 'nai-s-cmd' }, 'node import-artists.mjs <画师串.json> [更多.json …]'))
                    : h(
                        'div',
{ className: 'nai-s-styles', role: 'listbox', 'aria-label': t('sideStyle') },
                        h(
                          'div',
                          { className: 'nai-s-stylecard', 'data-selected': styleOn ? undefined : '1' },
                          h(
                            'button',
                            {
                              type: 'button',
                              role: 'option',
                              className: 'nai-s-stylecard-pick',
                              'aria-selected': styleOn ? 'false' : 'true',
                              disabled: busy === 'artist:-1',
                              onClick: () => onPickArtist(-1)
                            },
                            h('span', { className: 'nai-s-stylecard-art' }, h('span', { className: 'nai-s-swatch', 'data-blank': '1' }, '∅')),
                            h('span', { className: 'nai-s-stylecard-scrim' }),
                            h('span', { className: 'nai-s-stylecard-text' }, h('span', { className: 'nai-s-stylecard-name' }, t('sideStyleOff')))
                          )
                        ),
                        artists.map((row, at) =>
                          h(
                            'div',
                            {
                              key: row.id,
                              className: 'nai-s-stylecard',
                              'data-selected': activeStyleId === row.id ? '1' : undefined,
                              style: { animationDelay: `${Math.min(at, 8) * 22}ms` }
                            },
                            h(
                              'button',
                              {
                                type: 'button',
                                role: 'option',
                                className: 'nai-s-stylecard-pick',
                                title: `${row.name}${row.group ? `\n${row.group}` : ''}`,
                                'aria-selected': activeStyleId === row.id ? 'true' : 'false',
                                disabled: busy === `artist:${row.id}`,
                                onClick: () => {
                                  onPickArtist(row.id)
                                  setStylePickerOpen(false)
                                }
                              },
                              h(
                                'span',
                                { className: 'nai-s-stylecard-art' },
                                row.hasThumb || row.hasImage || row.hasCover ? h('img', { src: artistThumb(row.id, row.coverVersion), alt: '', loading: 'lazy' }) : swatch(row.name, row.group)
                              ),
                              h('span', { className: 'nai-s-stylecard-scrim' }),
                              h(
                                'span',
                                { className: 'nai-s-stylecard-text' },
                                h('span', { className: 'nai-s-stylecard-name' }, row.name),
                                h('span', { className: 'nai-s-stylecard-meta' }, row.user ? t('sideArtMine') : row.edited ? t('sideArtEdited') : row.group || `#${row.id}`)
                              )
                            ),
                            row.hasThumb || row.hasImage || row.hasCover
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'nai-s-stylecard-eye',
                                    'aria-label': t('sideStylePreview'),
                                    title: t('sideStylePreview'),
                                    onClick: (event) => {
                                      event.stopPropagation()
                                      openArtistPreview(row.id)
                                    }
                                  },
                                  '⤢'
                                )
                              : null
                          )
                        )
                      ),
                  artistTotal > 0 && artists.length === 0 ? h('div', { className: 'nai-s-empty' }, t('sideStyleEmpty')) : null,
                  h(
                    'div',
                    { className: 'nai-s-row' },
                    h('span', { className: 'nai-s-hint', style: { flex: 1 } }, `${artistTotal} ${t('sideStyleTotal')} · ${t('sideStyleApplies')}`)
                  )
                )
              : null
          )

        // ------------------------------------------------------ batch 3 helpers --
        // An empty reference library is hidden rather than shown as five dead chips;
        // its index card moves to 设置 with a note on how to fill it.
        const hasBooks = (libInfo?.indexed ?? status?.libraries ?? []).some((row) => Number(row?.entries) > 0)
        const elapsed = busySince > 0 ? Math.max(0, Math.round((Date.now() - busySince) / 1000)) : 0
        const net = status?.network ?? null
        const modelOptions = (Array.isArray(status?.models) && status.models.length > 0 ? status.models : MODEL_FALLBACK).filter(
          (model) => model && model.id && !model.inpaint && !/-inpainting$/.test(model.id)
        )
        const modelKnown = modelOptions.some((model) => model.id === form.model)
        const familyLabel = { v5: 'V5', 'v4.5': 'V4.5', v4: 'V4', v3: 'V3' }
        const modelPicker = () =>
          h(
            'label',
            { className: 'nai-s-field' },
            h('span', { className: 'nai-s-label' }, t('model')),
            h(
              'select',
              {
                className: 'nai-s-in',
                value: modelKnown && !modelCustom ? String(form.model) : '__custom',
                onChange: (event) => {
                  if (event.target.value === '__custom') setModelCustom(true)
                  else {
                    setModelCustom(false)
                    setForm((prev) => ({ ...prev, model: event.target.value }))
                  }
                }
              },
              [...new Set(modelOptions.map((model) => model.family ?? 'other'))].map((family) =>
                h(
                  'optgroup',
                  { key: family, label: familyLabel[family] ?? family },
                  modelOptions.filter((model) => (model.family ?? 'other') === family).map((model) => h('option', { key: model.id, value: model.id }, model.label ?? model.id))
                )
              ),
              h('option', { value: '__custom' }, t('sideModelCustom'))
            ),
            !modelKnown || modelCustom
              ? h('input', { className: 'nai-s-in nai-s-mono', spellCheck: false, placeholder: 'nai-diffusion-…', value: form.model ?? '', onChange: set('model') })
              : null,
            h('span', { className: 'nai-s-hint' }, t('sideModelHint'))
          )
        const fmtCount = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—')
        const fmtDuration = (seconds) => {
          const n = Math.max(0, Math.round(Number(seconds) || 0))
          if (n < 60) return `${n}s`
          if (n < 3600) return `${Math.round(n / 60)} min`
          return `${Math.floor(n / 3600)} h ${Math.round((n % 3600) / 60)} min`
        }
        const energyText = (energy) =>
          energy === null || energy === undefined
            ? null
            : energy.unavailable
              ? t('sideEnergyEmpty')
              : `${t('sideEnergy')} ${energy.percent ?? '—'}%${energy.refillSeconds === 0 ? ` · ${t('sideEnergyFull')}` : energy.refillSeconds > 0 ? ` · ${fmtDuration(energy.refillSeconds)} ${t('sideEnergyRefill')}` : ''}`
        const balanceRows = Array.isArray(balance?.keys) ? balance.keys : []
        const balanceFirst = balanceRows.find((row) => row.ok) ?? null
        const fmtBytes = (bytes) => {
          const n = Number(bytes) || 0
          return n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
        }

        // ------------------------------------------------------------ create --
        const charList = charDoc?.characters ?? []
        const charById = new Map(charList.map((row) => [row.id, row]))
        const visionOff = llmInfo?.available === true && llmInfo.vision === false
        const llmLine = llmInfo === null ? '' : llmInfo.available ? `${llmInfo.provider}/${llmInfo.model}` : String(llmInfo.reason ?? '')
        const writing = busy === 'write'
        const sentChars = charRows.filter((row) => String(row.positive).trim() !== '').length
        const renderSize = callSize ?? { width: status?.width, height: status?.height }
        const seedValid = seedText.trim() === '' || (/^\d+$/.test(seedText.trim()) && Number(seedText) > 0 && Number(seedText) <= 4294967295)

        /** A positive/negative textarea pair bound to two caption fields. */
        const captionPair = (posField, negField, posValue, negValue, onPos, onNeg, rows, posPlaceholder) =>
          h(
            'div',
            { className: 'nai-s-cap-pair' },
            h('textarea', {
              className: 'nai-s-in nai-s-mono',
              rows,
              spellCheck: false,
              'aria-label': t('sidePositive'),
              placeholder: posPlaceholder ?? t('sidePositive'),
              value: posValue,
              onChange: (event) => {
                onPos(event.target.value)
                trackCaret(posField)(event)
              },
              onFocus: trackCaret(posField),
              onSelect: trackCaret(posField),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && busy !== 'render') {
                  event.preventDefault()
                  onRender()
                }
              }
            }),
            h('textarea', {
              className: 'nai-s-in nai-s-mono nai-s-neg',
              rows,
              spellCheck: false,
              'aria-label': t('sideNegative'),
              placeholder: t('sideNegative'),
              value: negValue,
              onChange: (event) => {
                onNeg(event.target.value)
                trackCaret(negField)(event)
              },
              onFocus: trackCaret(negField),
              onSelect: trackCaret(negField)
            })
          )

        /** NovelAI's 5×5 position grid for one character; clicking the chosen cell again means "auto". */
        const positionGrid = (row, index) => {
          const cell = wbCellOf(row.center)
          const pick = (col, r) => setRow(index, { center: cell && cell.col === col && cell.row === r ? null : wbCellPoint(col, r) })
          const onKey = (event) => {
            const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
            if (moves[event.key]) {
              event.preventDefault()
              const from = cell ?? { col: 2, row: 2 }
              const col = Math.min(4, Math.max(0, from.col + moves[event.key][0]))
              const r = Math.min(4, Math.max(0, from.row + moves[event.key][1]))
              setRow(index, { center: wbCellPoint(col, r) })
            } else if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Escape') {
              event.preventDefault()
              setRow(index, { center: null })
            }
          }
          return [
            h(
              'div',
              {
                key: 'grid',
                className: 'nai-s-grid5',
                role: 'grid',
                tabIndex: 0,
                'aria-label': `${t('sidePosition')} ${cell ? cell.label : t('sidePosAuto')}`,
                title: t('sidePositionHint'),
                'data-auto': cell ? undefined : '1',
                onKeyDown: onKey
              },
              Array.from({ length: 25 }, (_, n) => {
                const col = n % 5
                const r = Math.floor(n / 5)
                return h('span', {
                  key: n,
                  'data-on': cell && cell.col === col && cell.row === r ? '1' : undefined,
                  'data-mid': col === 2 && r === 2 ? '1' : undefined,
                  title: `${'ABCDE'[col]}${r + 1}`,
                  onClick: () => pick(col, r)
                })
              })
            ),
            h('span', { key: 'cap', className: 'nai-s-grid5-cap' }, cell ? cell.label : t('sidePosAuto'))
          ]
        }

        /**
         * The one place a character is added to a render: the library first, then
         * an empty row for a character that is not in it. What it adds shows up as
         * a chip under the prompt, so there is no second button to find.
         */
        const characterAdder = () =>
          h(
            'select',
            {
              className: 'nai-s-in nai-s-adder',
              'aria-label': t('sideAddChar'),
              value: '',
              disabled: charRows.length >= WB_MAX_CHARACTERS,
              onChange: (event) => {
                const value = String(event.target.value)
                if (value === '__blank') {
                  addRow({ open: true })
                  return
                }
                const [id, variant] = value.split('::')
                const character = charById.get(id)
                if (character) addRow({ ...rowFromCharacter(character, variant === undefined ? undefined : Number(variant)), charId: id, open: true })
              }
            },
            h('option', { value: '' }, `＋ ${t('sideAddChar')}`),
            h('option', { value: '__blank' }, t('sideAddCharBlank')),
            (charDoc?.groups ?? []).map((group) =>
              h(
                'optgroup',
                { key: group.id, label: group.name },
                charList
                  .filter((row) => row.groupId === group.id)
                  .flatMap((row) => [
                    h('option', { key: row.id, value: row.id }, row.name),
                    ...(row.variableFeatures ?? []).flatMap((variant, at) =>
                      wbPromptTags(variant.prompt) === ''
                        ? []
                        : [h('option', { key: `${row.id}::${at}`, value: `${row.id}::${at}` }, `　${row.name} · ${variant.name || at + 1}`)]
                    )
                  ])
              )
            )
          )

        // The tag market, filtered by category path and search.
        const catalog = market?.catalog ?? null
        const marketEntries = (catalog?.entries ?? []).map((entry) => {
          const path = String(entry.key ?? '').split('·').map((part) => part.trim()).filter(Boolean)
          return { ...entry, path, leaf: path[path.length - 1] ?? String(entry.key ?? '') }
        })
        const marketLevels = []
        {
          let pool = marketEntries
          for (let depth = 0; depth < 4; depth += 1) {
            const options = [...new Set(pool.filter((entry) => entry.path.length > depth + 1).map((entry) => entry.path[depth]))]
            if (options.length === 0) break
            const chosen = marketPath[depth] && options.includes(marketPath[depth]) ? marketPath[depth] : depth === 0 ? options[0] : ''
            marketLevels.push({ depth, options, chosen })
            if (chosen === '') break
            pool = pool.filter((entry) => entry.path[depth] === chosen)
          }
        }
        const marketQ = marketQuery.trim().toLowerCase()
        const marketShown = marketQ !== ''
          ? marketEntries.filter((entry) => `${entry.key} ${entry.value}`.toLowerCase().includes(marketQ)).slice(0, 200)
          : marketEntries.filter((entry) => marketLevels.every((level) => level.chosen === '' || entry.path[level.depth] === level.chosen)).slice(0, 300)

        const createPane = h(
          'div',
          { className: 'nai-s-pane', hidden: sideNav !== 'create' },
          styleArea('create'),

          // 写提示词: natural language (+ reference image, references, characters) → caption.
          h(
            'div',
            {
              className: 'nai-s-write',
              'data-drop': writeDrop ? '1' : undefined,
              onDragOver: (event) => {
                if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file')) {
                  event.preventDefault()
                  setWriteDrop(true)
                }
              },
              onDragLeave: () => setWriteDrop(false),
              onDrop: (event) => {
                setWriteDrop(false)
                const file = imageFromTransfer(event.dataTransfer)
                if (file) {
                  event.preventDefault()
                  takeRefImage(file)
                }
              }
            },
            h('div', { className: 'nai-s-write-head' }, h('span', { style: { flex: 1 } }, t('sideWriteTitle')), llmLine ? h('span', { className: 'nai-s-mono', title: t('sideWriteModel') }, llmLine) : null),
            h('textarea', {
              ref: nlRef,
              'aria-label': t('sideWriteTitle'),
              placeholder: t('sideWritePlaceholder'),
              value: nlText,
              onChange: (event) => setNlText(event.target.value),
              onPaste: (event) => {
                const file = imageFromTransfer(event.clipboardData)
                if (file) {
                  event.preventDefault()
                  takeRefImage(file)
                }
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !writing) {
                  event.preventDefault()
                  onWrite()
                }
              }
            }),
            refImage !== null || pickedRefs.length > 0 || pickedChars.length > 0
              ? h(
                  'div',
                  { className: 'nai-s-attach' },
                  refImage !== null
                    ? h(
                        'span',
                        { className: 'nai-s-tok', title: refImage.name },
                        h('img', { src: refImage.dataUrl, alt: '' }),
                        h('span', null, t('sideRefImage')),
                        h('button', { type: 'button', 'aria-label': t('sideRemove'), onClick: () => setRefImage(null) }, '×')
                      )
                    : null,
                  pickedChars.map((id) =>
                    h(
                      'span',
                      { key: id, className: 'nai-s-tok', 'data-kind': 'char' },
                      h('span', null, `${t('sideCharTok')} · ${charById.get(id)?.name ?? '?'}`),
                      h('button', { type: 'button', 'aria-label': t('sideRemove'), onClick: () => togglePickedChar(id) }, '×')
                    )
                  ),
                  pickedRefs.map((row) =>
                    h(
                      'span',
                      { key: row.key, className: 'nai-s-tok', title: row.content.slice(0, 300) },
                      h('span', null, `${row.library} · ${row.title}`),
                      h('button', { type: 'button', 'aria-label': t('sideRemove'), onClick: () => setPickedRefs((list) => list.filter((item) => item.key !== row.key)) }, '×')
                    )
                  )
                )
              : null,
            h(
              'div',
              { className: 'nai-s-write-bar' },
              btn(t('sideAttachImage'), () => refFileInput.current?.click(), { kind: 'ghost', size: 's', title: t('sideAttachHint') }),
              h('input', {
                ref: refFileInput,
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp,image/gif',
                hidden: true,
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) takeRefImage(file)
                }
              }),
              charList.length > 0
                ? h(
                    'select',
                    {
                      className: 'nai-s-in nai-s-write-char',
                      'aria-label': t('sideInsertChar'),
                      title: t('sideInsertCharHint'),
                      value: '',
                      onChange: (event) => insertCharKeyword(event.target.value)
                    },
                    h('option', { value: '' }, `＋ ${t('sideInsertChar')}`),
                    (charDoc?.groups ?? []).map((group) =>
                      h(
                        'optgroup',
                        { key: group.id, label: group.name },
                        charList.filter((row) => row.groupId === group.id).map((row) => h('option', { key: row.id, value: row.id }, row.name))
                      )
                    )
                  )
                : null,
              hasBooks
                ? btn(t('sidePickRefs'), () => {
                    setLibView('books')
                    setSideNav('library')
                  }, { kind: 'ghost', size: 's' })
                : null,
              refImage !== null ? btn(t('sideRefToI2i'), refToImg2Img, { kind: 'ghost', size: 's', disabled: busy === 'upload' }) : null,
              h('span', { className: 'nai-s-sp' }),
              writing ? btn(t('sideCancel'), onWriteCancel, { size: 's' }) : null,
              btn(writing ? t('sideWriting') : refImage !== null ? t('sideReverse') : t('sideWrite'), onWrite, {
                kind: 'primary',
                size: 's',
                disabled: writing || llmInfo?.available === false,
                title: refImage !== null ? t('sideReverseHint') : t('sideWriteHint')
              })
            )
          ),
          llmInfo?.available === false
            ? h('p', { className: 'nai-s-hint', style: { color: 'var(--bad)' } }, `${t('sideLlmOff')}：${llmInfo.reason ?? ''}`)
            : refImage !== null && visionOff
              ? h('p', { className: 'nai-s-hint', style: { color: 'var(--warn)' } }, t('sideVisionOff'))
              : null,
          writeFail !== null
            ? h(
                'div',
                { className: 'nai-s-failcard', role: 'alert' },
                h(
                  'div',
                  { className: 'nai-s-failcard-head' },
                  h('strong', null, writeFail.code === 'WRITER_REFUSED' ? t('sideWriteRefused') : t('sideWriteInvalid')),
                  h('span', { className: 'nai-s-sp' }),
                  writeFail.logId ? btn(t('sideLogOpen'), () => openLogEntry(writeFail.logId), { kind: 'ghost', size: 's' }) : null,
                  btn('×', () => setWriteFail(null), { kind: 'ghost', size: 's', title: t('sideRemove') })
                ),
                h('p', { className: 'nai-s-failcard-msg' }, writeFail.message),
                writeFail.code !== 'WRITER_REFUSED' && writeFail.issues.length > 0
                  ? h('ul', { className: 'nai-s-failcard-issues' }, writeFail.issues.map((issue, at) => h('li', { key: at }, issue)))
                  : null,
                h(
                  'p',
                  { className: 'nai-s-hint nai-s-mono' },
                  [writeFail.route ? `${writeFail.route.provider}/${writeFail.route.model}` : null, writeFail.attempts ? t('sideWriteAttempts').replace('{n}', String(writeFail.attempts)) : null, writeFail.characters.length ? `${t('sideCharTok')} ${writeFail.characters.join('、')}` : null]
                    .filter(Boolean)
                    .join(' · ')
                ),
                writeFail.raw
                  ? h(
                      'details',
                      { className: 'nai-s-failcard-raw' },
                      h('summary', null, `${t('sideWriteRaw')}（${writeFail.raw.length}）`),
                      h('pre', { className: 'nai-s-logjson' }, writeFail.raw.slice(0, 4000)),
                      h('div', null, btn(t('sideCopy'), () => copyTextToClipboard(writeFail.raw).then(() => setNotice(t('sideCopied'))).catch(() => {}), { kind: 'ghost', size: 's' }))
                    )
                  : null
              )
            : lastWrite !== null
            ? h(
                'details',
                { className: 'nai-s-card' },
                h(
                  'summary',
                  null,
                  h('span', { className: 'nai-s-card-title' }, lastWrite.reverse ? t('sideReverseResult') : t('sideWriteResult')),
                  h(
                    'span',
                    { className: 'nai-s-card-sum nai-s-mono' },
                    [lastWrite.matched?.length ? `${t('sideCharTok')} ${lastWrite.matched.join('、')}` : null, lastWrite.attempts > 1 ? `${t('sideAttempts')} ${lastWrite.attempts}` : null, lastWrite.route?.model]
                      .filter(Boolean)
                      .join(' · ')
                  )
                ),
                h('div', { className: 'nai-s-card-body' }, h('p', { className: 'nai-s-hint', style: { whiteSpace: 'pre-wrap' } }, lastWrite.analysis || t('sideNoAnalysis')))
              )
            : null,

          // 当前提示词: what 出图 sends.
          h(
            'div',
            { className: 'nai-s-cap' },
            h(
              'div',
              { className: 'nai-s-cap-head' },
              h('strong', null, t('sideCaption')),
              h('span', { className: 'nai-s-sp' }),
              btn(t('sideClear'), onClearCaption, { kind: 'ghost', size: 's' })
            ),
            captionPair('base', 'baseNeg', prompt, baseNeg, setPrompt, setBaseNeg, 4, t('sideScenePlaceholder')),
            h(
              'div',
              { className: 'nai-s-charrow' },
              charRows.map((row, index) =>
                h(
                  'span',
                  { key: row.key, className: 'nai-s-chartag', 'data-open': row.open ? '1' : undefined },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'nai-s-chartag-main',
                      'aria-expanded': row.open ? 'true' : 'false',
                      title: t('sideCharTagHint'),
                      onClick: () => setRow(index, { open: !row.open })
                    },
                    h('span', { className: 'nai-s-chartag-name' }, row.name || `#${index + 1}`),
                    h('span', { className: 'nai-s-chartag-pos' }, wbCellOf(row.center)?.label ?? t('sidePosAuto'))
                  ),
                  h('button', { type: 'button', className: 'nai-s-chartag-x', 'aria-label': t('sideRemove'), onClick: () => removeRow(index) }, '×')
                )
              ),
              characterAdder()
            ),
            charRows.map((row, index) =>
              row.open === false
                ? null
                : h(
                'div',
                { key: row.key, className: 'nai-s-row-card' },
                ...positionGrid(row, index),
                h(
                  'div',
                  { className: 'nai-s-row-top' },
                  h('span', { className: 'nai-s-row-num' }, `#${index + 1}`),
                  h('input', {
                    className: 'nai-s-in',
                    placeholder: t('sideRowName'),
                    value: row.name,
                    onChange: (event) => setRow(index, { name: event.target.value })
                  }),
                  btn('↑', () => moveRow(index, -1), { kind: 'ghost', size: 's', disabled: index === 0, title: t('sideMoveUp') }),
                  btn('↓', () => moveRow(index, 1), { kind: 'ghost', size: 's', disabled: index === charRows.length - 1, title: t('sideMoveDown') }),
                  btn('×', () => removeRow(index), { kind: 'ghost', size: 's', title: t('sideRemove') })
                ),
                captionPair(
                  `row${index}pos`,
                  `row${index}neg`,
                  row.positive,
                  row.negative,
                  (value) => setRow(index, { positive: value }),
                  (value) => setRow(index, { negative: value }),
                  3,
                  t('sideRowPlaceholder')
                )
              )
            ),
            h(
              'div',
              { className: 'nai-s-row' },
              h('span', { className: 'nai-s-sp' }),
              h(
                'label',
                { className: 'nai-s-check-inline', title: t('sideReplaceKwHint') },
                h('input', { type: 'checkbox', checked: replaceKw, onChange: (event) => setReplaceKw(event.target.checked) }),
                t('sideReplaceKw')
              )
            )
          ),

          // 出图
          h(
            'div',
            { className: 'nai-s-composer' },
            h(
              'div',
              { className: 'nai-s-composer-bar', style: { borderTop: 0, flexWrap: 'wrap' } },
              h(
                'span',
                { className: 'nai-s-receipt nai-s-mono' },
                `${renderSize.width ?? '—'}×${renderSize.height ?? '—'} · ${status?.steps ?? '—'} steps · cfg ${status?.scale ?? '—'}${sentChars > 0 ? ` · ${sentChars} ${t('sideCharsShort')}` : ''}`
              ),
              h(
                'span',
                { className: 'nai-s-seed' },
                h('input', {
                  className: 'nai-s-in nai-s-mono',
                  inputMode: 'numeric',
                  placeholder: t('sideSeedRandom'),
                  'aria-label': t('sideSeed'),
                  'aria-invalid': seedValid ? undefined : 'true',
                  value: seedText,
                  onChange: (event) => setSeedText(event.target.value.replace(/[^\d]/g, ''))
                }),
                lastSeed !== null ? btn('↺', () => setSeedText(String(lastSeed)), { kind: 'ghost', size: 's', title: `${t('sideSeedReuse')} ${lastSeed}` }) : null,
                seedText !== '' ? btn('×', () => setSeedText(''), { kind: 'ghost', size: 's', title: t('sideSeedRandom') }) : null
              ),
              h(
                'select',
                { className: 'nai-s-in', 'aria-label': t('variants'), value: String(variants), onChange: (event) => setVariants(Number(event.target.value)) },
                Array.from({ length: variantCap }, (_, index) => index + 1).map((n) => h('option', { key: n, value: String(n) }, `×${n}`))
              ),
              btn(busy === 'render' ? t('testing') : t('sideRender'), onRender, { kind: 'primary', disabled: busy === 'render' || !seedValid })
            )
          ),
          h(
            'div',
            { className: 'nai-s-pills' },
            credentialOk ? null : h('button', { type: 'button', className: 'nai-s-pill', 'data-tone': 'bad', onClick: () => setSideNav('settings') }, t('sideNoTokenPill')),
            Number(variants) > 1
              ? h('span', { className: 'nai-s-pill', 'data-tone': 'warn' }, t('sideNotFreeVariants'))
              : h('span', { className: 'nai-s-pill', 'data-tone': freeBand && callSize === null ? 'ok' : 'warn' }, freeBand && callSize === null ? t('sideFree') : t('sideNotFree')),
            callSize !== null
              ? h('button', { type: 'button', className: 'nai-s-pill', 'data-tone': 'warn', title: t('sideCallSizeHint'), onClick: () => setCallSize(null) }, `${t('sideCallSize')} ${callSize.width}×${callSize.height} ×`)
              : null,
            replaceKw ? h('span', { className: 'nai-s-pill' }, t('sideReplaceKwOn')) : null,
            status?.transparentBackground === true && /^nai-diffusion-5/.test(String(status?.model))
              ? h('button', { type: 'button', className: 'nai-s-pill', 'data-tone': 'warn', title: t('sideTransparentOffHint'), onClick: onToggleTransparent, disabled: busy === 'transparent' }, `${t('sideTransparent')} ×`)
              : null,
            artistOverride() !== undefined ? h('span', { className: 'nai-s-pill', 'data-tone': 'warn' }, t('sideArtOverrideOn')) : null
          ),

          panelCard(
            t('sideExtras'),
            [status?.header ? `+ ${status.header}` : t('sideNoHeader'), `${t('quality')} ${onOff(status?.qualityToggle === true)}`, `UC ${String(status?.negativePrompt ?? '').length}`].join(' · '),
            false,
            field('header', t('header'), { mono: true, placeholder: 'fur dataset' }),
            h('p', { className: 'nai-s-hint' }, t('headerHint')),
            switchRow(t('quality'), t('qualityHint'), status?.qualityToggle === true, onToggleQuality, busy === 'quality'),
            h(
              'label',
              { className: 'nai-s-field' },
              h('span', { className: 'nai-s-label' }, t('negative')),
              h('textarea', { className: 'nai-s-in nai-s-mono', rows: 4, spellCheck: false, value: form.negativePrompt ?? '', onChange: set('negativePrompt') })
            )
          ),
          panelCard(
            t('sideSampling'),
            `${String(form.model ?? '').replace(/^nai-diffusion-/, '')} · ${form.width}×${form.height} · ${form.steps} · cfg ${form.scale} · ${String(form.sampler ?? '').replace(/^k_/, '')}${Number(form.cfgRescale) > 0 ? ` · rescale ${form.cfgRescale}` : ''}${form.variety === true ? ' · variety' : ''}${status?.transparentBackground === true && /^nai-diffusion-5/.test(String(status?.model)) ? ` · ${t('sideTransparent')}` : ''}`,
            false,
            modelPicker(),
            h(
              'div',
              { className: 'nai-s-seg', role: 'group' },
              [
                ['p', t('sidePortrait'), 832, 1216],
                ['l', t('sideLandscape'), 1216, 832],
                ['s', t('sideSquare'), 1024, 1024]
              ].map(([key, text, w, hh]) =>
                h(
                  'button',
                  { key, type: 'button', 'aria-pressed': Number(form.width) === w && Number(form.height) === hh ? 'true' : 'false', onClick: () => setForm((prev) => ({ ...prev, width: w, height: hh })) },
                  `${text} ${w}×${hh}`
                )
              )
            ),
            h(
              'div',
              { className: 'nai-s-grid' },
              field('width', t('width'), { type: 'number', step: 64, mono: true }),
              field('height', t('height'), { type: 'number', step: 64, mono: true }),
              field('steps', t('steps'), { type: 'number', min: 1, max: 50, mono: true }),
              field('scale', t('scale'), { type: 'number', step: 0.1, mono: true }),
              field('sampler', t('sampler'), { list: 'nai-s-samplers', mono: true }),
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, t('ucPreset')),
                h('select', { className: 'nai-s-in', value: String(form.ucPreset ?? 3), onChange: set('ucPreset') }, ucNames.map((name, index) => h('option', { key: index, value: String(index) }, `${index} · ${name}`)))
              ),
              field('cfgRescale', 'CFG Rescale', { type: 'number', min: 0, max: 1, step: 0.01, mono: true }),
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, t('sideNoiseSchedule')),
                h(
                  'select',
                  {
                    className: 'nai-s-in',
                    value: /^nai-diffusion-5/.test(String(form.model)) ? 'karras' : String(form.noiseSchedule ?? 'karras'),
                    disabled: /^nai-diffusion-5/.test(String(form.model)),
                    title: /^nai-diffusion-5/.test(String(form.model)) ? t('sideNoiseV5') : undefined,
                    onChange: set('noiseSchedule')
                  },
                  ['karras', 'native', 'exponential', 'polyexponential'].map((name) => h('option', { key: name, value: name }, name))
                )
              )
            ),
            /^nai-diffusion-4-5/.test(String(form.model))
              ? switchRow('Variety+', t('sideVarietyHint'), form.variety === true, () => setForm((prev) => ({ ...prev, variety: prev.variety !== true })), false)
              : null,
            /^nai-diffusion-5/.test(String(form.model))
              ? switchRow(t('sideTransparent'), t('sideTransparentHint'), status?.transparentBackground === true, onToggleTransparent, busy === 'transparent')
              : h('p', { className: 'nai-s-hint' }, t('sideTransparentV5')),
            /^nai-diffusion-3|^nai-diffusion-furry-3/.test(String(form.model))
              ? h(
                  'label',
                  { className: 'nai-s-field' },
                  h('span', { className: 'nai-s-label' }, 'SMEA'),
                  h(
                    'select',
                    { className: 'nai-s-in', value: String(form.smea ?? 'off'), onChange: set('smea') },
                    [['off', t('sideOff')], ['smea', 'SMEA'], ['smea_dyn', 'SMEA DYN']].map(([value, text]) => h('option', { key: value, value }, text))
                  ),
                  h('span', { className: 'nai-s-hint' }, t('sideSmeaHint'))
                )
              : null,
            heavy ? h('p', { className: 'nai-s-hint', style: { color: 'var(--warn)' } }, t('heaviest')) : null
          ),
          panelCard(
            t('sideMarket'),
            catalog ? `${marketEntries.length} ${t('sideMarketTags')}` : t('sideMarketNone'),
            false,
            catalog === null
              ? h('p', { className: 'nai-s-hint' }, market?.error ?? t('sideMarketEmpty'))
              : h(
                  'div',
                  { className: 'nai-s-market' },
                  h('input', { className: 'nai-s-in', type: 'search', placeholder: t('sideMarketSearch'), value: marketQuery, onChange: (event) => setMarketQuery(event.target.value) }),
                  marketQ === ''
                    ? marketLevels.map((level) =>
                        h(
                          'div',
                          { key: level.depth, className: 'nai-s-market-tabs', role: 'group' },
                          level.depth > 0
                            ? h('button', { type: 'button', className: 'nai-s-chip', 'aria-pressed': level.chosen === '' ? 'true' : 'false', onClick: () => setMarketPath((path) => [...path.slice(0, level.depth), ''].slice(0, level.depth + 1)) }, t('sideAllLibs'))
                            : null,
                          level.options.map((name) =>
                            h(
                              'button',
                              { key: name, type: 'button', className: 'nai-s-chip', 'aria-pressed': level.chosen === name ? 'true' : 'false', onClick: () => setMarketPath((path) => [...path.slice(0, level.depth), name]) },
                              name
                            )
                          )
                        )
                      )
                    : null,
                  marketShown.length === 0
                    ? h('div', { className: 'nai-s-empty' }, t('sideNoHits'))
                    : h(
                        'div',
                        { className: 'nai-s-market-grid' },
                        marketShown.map((entry) =>
                          h(
                            'button',
                            {
                              key: entry.id,
                              type: 'button',
                              className: 'nai-s-tag',
                              title: `${entry.path.join(' · ')}\n${entry.value}`,
                              'aria-pressed': tagInCaption(String(entry.value).trim()) ? 'true' : 'false',
                              // Keep the caption field focused, so the tag lands at its caret.
                              onMouseDown: (event) => event.preventDefault(),
                              onClick: () => toggleTag(entry.value)
                            },
                            h('b', null, entry.leaf),
                            h('i', null, entry.value)
                          )
                        )
                      ),
                  h('p', { className: 'nai-s-hint' }, t('sideMarketHint'))
                ),
            h(
              'div',
              { className: 'nai-s-row' },
              btn(t('sideImport'), () => marketImportInput.current?.click(), { size: 's', disabled: busy === 'market' }),
              catalog ? h('a', { className: 'nai-s-btn', 'data-size': 's', href: `${API}/market/export`, download: 'nai-tag-market.json' }, t('sideExport')) : null,
              h('input', { ref: marketImportInput, type: 'file', accept: 'application/json,.json', hidden: true, onChange: onMarketImport })
            )
          ),
          h('div', { className: 'nai-s-sect' }, h('span', { className: 'nai-s-sp' }, t('sideLatest')), btn(t('refresh'), refresh, { kind: 'ghost', size: 's' })),
          shots.length === 0 ? h('div', { className: 'nai-s-empty' }, t('sideGalleryEmpty')) : shot(shots[0], true),
          shots.length > 1 ? h('div', { className: 'nai-s-shots' }, shots.slice(1).map((file) => shot(file, false))) : null
        )

        // -------------------------------------------------------------- edit --
        const editPane = h(
          'div',
          { className: 'nai-s-pane', hidden: sideNav !== 'edit' },
          seg(editTool, setEditTool, [
            ['i2i', t('i2iTitle')],
            ['inpaint', t('sideInpaint')],
            ['director', t('sideDirector')]
          ]),
          editTool === 'director' ? null : styleArea('edit'),
          editTool === 'director'
            ? null
            : h('label', { className: 'nai-s-field' }, h('span', { className: 'nai-s-label' }, t('sideSharedPrompt')), promptBox(3)),
          editTool !== 'director' && sentChars > 0 ? h('p', { className: 'nai-s-hint' }, `${t('sideEditWithChars')} ${sentChars}`) : null,
          // image-to-image
          h(
            'div',
            { className: 'nai-s-stack', hidden: editTool !== 'i2i' },
            pickBox(
              sourceName ? `${API}/source-file?name=${encodeURIComponent(sourceName)}` : '',
              sourceName || t('i2iNoPick'),
              btn(sourceName ? t('i2iPickChange') : t('i2iPick'), () => setPickerOpen(true), { size: 's' }),
              btn(busy === 'upload' ? t('i2iUploading') : t('i2iUpload'), onPickFile, { size: 's', disabled: busy === 'upload' }),
              sourceName ? btn(t('i2iRelease'), () => setSourceName(''), { size: 's', kind: 'ghost' }) : null
            ),
            h(
              'div',
              { className: 'nai-s-grid' },
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, `strength ${strength}`),
                h('input', {
                  className: 'nai-s-range',
                  type: 'range',
                  min: 0.01,
                  max: 0.99,
                  step: 0.01,
                  value: strength,
                  onChange: (event) => setStrength(event.target.value)
                })
              ),
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, `noise ${noise}`),
                h('input', {
                  className: 'nai-s-range',
                  type: 'range',
                  min: 0,
                  max: 0.99,
                  step: 0.01,
                  value: noise,
                  onChange: (event) => setNoise(event.target.value)
                })
              ),
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, t('width')),
                h('input', {
                  className: 'nai-s-in nai-s-mono',
                  type: 'number',
                  step: 64,
                  value: i2iWidth === '' ? (status?.width ?? '') : i2iWidth,
                  onChange: (event) => setI2iWidth(event.target.value)
                })
              ),
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, t('height')),
                h('input', {
                  className: 'nai-s-in nai-s-mono',
                  type: 'number',
                  step: 64,
                  value: i2iHeight === '' ? (status?.height ?? '') : i2iHeight,
                  onChange: (event) => setI2iHeight(event.target.value)
                })
              )
            ),
            h(
              'div',
              { className: 'nai-s-row' },
              btn(busy === 'i2i' ? t('i2iRunning') : t('i2iRun'), onImg2Img, { kind: 'primary', disabled: busy === 'i2i' || sourceName === '' }),
              h('span', { className: 'nai-s-sp' }),
              btn(t('i2iRefresh'), loadSources, { kind: 'ghost', size: 's', disabled: busy === 'sources' })
            ),
            h('p', { className: 'nai-s-hint' }, t('sideI2iHint')),
            h('div', { className: 'nai-s-path' }, `${t('i2iSourceDir')}: ${status?.sourceDir ?? ''}`)
          ),
          // inpaint and director share the picked render
          editTool === 'i2i'
            ? null
            : pickBox(
                inpaintSource ? fileUrl(inpaintSource) : '',
                inpaintSource ? `${inpaintSource}${inpaintWidth ? ` · ${inpaintWidth}×${inpaintHeight}` : ''}` : t('sideNoRenderPicked'),
                btn(inpaintSource ? t('inpaintPickChange') : t('inpaintPick'), openInpaintPicker, { size: 's' })
              ),
          h(
            'div',
            { className: 'nai-s-stack', hidden: editTool !== 'inpaint' },
            h('p', { className: 'nai-s-hint' }, t('sideInpaintHint')),
            h(
              'div',
              { className: 'nai-s-grid' },
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, `${t('inpaintBrush')} ${brush}`),
                h('input', { className: 'nai-s-range', type: 'range', min: 4, max: 120, step: 2, value: brush, onChange: (event) => setBrush(event.target.value) })
              ),
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, `${t('inpaintStrength')} ${inpaintStrength}`),
                h('input', {
                  className: 'nai-s-range',
                  type: 'range',
                  min: 0,
                  max: 1,
                  step: 0.05,
                  value: inpaintStrength,
                  onChange: (event) => setInpaintStrength(event.target.value)
                })
              )
            ),
            h(
              'div',
              { className: 'nai-s-row' },
              btn(eraseMode ? t('inpaintEraseOn') : t('inpaintErase'), () => setEraseMode((value) => !value), { size: 's', pressed: eraseMode ? 'true' : 'false' }),
              btn(t('inpaintClear'), clearMask, { size: 's' }),
              h('span', { className: 'nai-s-sp' }),
              btn(busy === 'inpaint' ? t('inpaintRunning') : t('inpaintRun'), onInpaint, { kind: 'primary', disabled: busy === 'inpaint' || inpaintSource === '' })
            ),
            h(
              'div',
              {
                className: 'nai-s-canvas',
                hidden: inpaintSource === '',
                style: { '--ar': Number(inpaintWidth) > 0 && Number(inpaintHeight) > 0 ? Number(inpaintWidth) / Number(inpaintHeight) : 0.684 }
              },
              h('canvas', { ref: baseCanvas }),
              h('canvas', {
                ref: maskCanvas,
                onPointerDown: onMaskDown,
                onPointerMove: onMaskMove,
                onPointerUp: onMaskUp,
                onPointerLeave: onMaskUp
              })
            )
          ),
          h(
            'div',
            { className: 'nai-s-stack', hidden: editTool !== 'director' },
            h('p', { className: 'nai-s-hint' }, t('directorHint')),
            h(
              'div',
              { className: 'nai-s-grid' },
              h(
                'label',
                { className: 'nai-s-field' },
                h('span', { className: 'nai-s-label' }, t('directorTool')),
                h(
                  'select',
                  { className: 'nai-s-in', value: directorType, onChange: (event) => setDirectorType(event.target.value) },
                  [
                    ['lineart', t('directorLineart')],
                    ['sketch', t('directorSketch')],
                    ['colorize', t('directorColorize')],
                    ['emotion', t('directorEmotionTool')],
                    ['declutter', t('directorDeclutter')]
                  ].map(([value, text]) => h('option', { key: value, value }, text))
                )
              ),
              directorType === 'emotion'
                ? h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('directorEmotion')),
                    h('input', {
                      className: 'nai-s-in nai-s-mono',
                      placeholder: 'happy / sad / angry',
                      value: directorEmotion,
                      onChange: (event) => setDirectorEmotion(event.target.value)
                    })
                  )
                : null
            ),
            h(
              'div',
              null,
              btn(busy === 'director' ? t('directorRunning') : t('directorRun'), onDirector, { kind: 'primary', disabled: busy === 'director' || inpaintSource === '' })
            )
          )
        )

        // ----------------------------------------------------------- library --
        const indexedRows = libInfo?.indexed ?? (status?.libraries ?? []).filter((row) => row.entries > 0)
        const indexedMap = new Map(indexedRows.filter((row) => row.entries > 0).map((row) => [row.library, row.entries]))
        const knownLibs = libInfo?.known ?? (status?.libraries ?? []).map((row) => row.library)
        const rosterTag = (content) => {
          const line = String(content ?? '').split('\n').find((row) => /^\s*-\s*[^:：]+[:：]/.test(row))
          if (!line) return ''
          return line.replace(/^\s*-\s*[^:：]+[:：]\s*/, '').trim()
        }
        const libViewShown = !hasBooks && libView === 'books' ? 'artists' : libView
        /** The reference-library index card: in 参考库 when it has entries, in 设置 when it is empty. */
        const indexCard = () =>
          panelCard(
            t('sideIndexCard'),
            indexedMap.size > 0 ? `${indexedMap.size}/${knownLibs.length}` : t('sideNotIndexed'),
            false,
            hasBooks ? null : h('p', { className: 'nai-s-hint', style: { color: 'var(--ink2)' } }, t('sideBooksEmptyHint')),
            field('librarySourceDir', t('librarySourceDir'), { mono: true }),
            field('libraryDir', t('libraryDir'), { mono: true }),
            h('p', { className: 'nai-s-hint' }, t('sideIndexHint')),
            h('div', null, btn(busy === 'reindex' ? t('sideReindexing') : t('sideReindex'), onReindex, { kind: 'primary', disabled: busy === 'reindex' }))
          )
        const libraryPane = h(
          'div',
          { className: 'nai-s-pane', hidden: sideNav !== 'library' },
          seg(libViewShown, setLibView, [
            ['artists', t('artist')],
            ['chars', t('sideChars')],
            ...(hasBooks ? [['books', t('sideBooks')]] : [])
          ]),
          // artist strings
          h(
            'div',
            { className: 'nai-s-stack', hidden: libViewShown !== 'artists' },
            styleOn
              ? h(
                  'div',
                  { className: 'nai-s-current' },
                  styleDetail?.id === activeStyleId && (styleDetail?.image || styleDetail?.hasCover) ? h('img', { src: `${API}/artist-image?id=${activeStyleId}${styleDetail?.coverVersion ? `&v=${encodeURIComponent(styleDetail.coverVersion)}` : ''}`, alt: '' }) : swatch(styleName, styleDetail?.group),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontWeight: 600, wordBreak: 'break-word' } }, styleName || t('artistMissing')),
                    h('div', { className: 'nai-s-mono', style: { color: 'var(--ink3)' } }, `#${activeStyleId}`)
                  ),
                  btn(t('artistNone'), () => onPickArtist(-1), { size: 's', disabled: busy === 'artist:-1' })
                )
              : null,
            h(
              'div',
              { className: 'nai-s-row' },
              h('input', {
                className: 'nai-s-in',
                style: { flex: 1, width: 'auto' },
                placeholder: t('artistSearch'),
                value: artistQuery,
                onChange: (event) => onArtistQuery(event.target.value)
              }),
              btn(t('refresh'), () => loadArtists(artistQuery, artistGroup), { kind: 'ghost', size: 's' })
            ),
            groupChips(),
            h('div', { className: 'nai-s-hint' }, `${t('artistCount')} ${artistTotal} · ${t('artistCurrent')}：${styleOn ? styleName : t('artistNone')}`),
            artistTotal === 0
              ? h(
                  'div',
                  { className: 'nai-s-stack' },
                  h('p', { className: 'nai-s-hint' }, t('sideArtistEmpty')),
                  h('code', { className: 'nai-s-cmd' }, 'node import-artists.mjs <画师串.json> [更多.json …]')
                )
              : h(
                  'div',
                  { className: 'nai-s-artists' },
                  artists.map((row) =>
                    h(
                      'button',
                      {
                        key: row.id,
                        type: 'button',
                        className: 'nai-s-artist',
                        title: row.name,
                        'aria-pressed': activeStyleId === row.id ? 'true' : 'false',
                        ref: activeStyleId === row.id ? selectedArtistRow : undefined,
                        disabled: busy === `artist:${row.id}`,
                        onClick: () => onPickArtist(row.id)
                      },
                      row.hasThumb || row.hasImage
                        ? h('img', { src: `${API}/artist-image?id=${row.id}&thumb=1${row.coverVersion ? `&v=${encodeURIComponent(row.coverVersion)}` : ''}`, alt: '', loading: 'lazy' })
                        : swatch(row.name, row.group),
                      h('span', { className: 'nai-s-artist-name' }, row.name, h('span', { className: 'nai-s-mono', style: { display: 'block', color: 'var(--ink4)' } }, `#${row.id}`))
                    )
                  )
                ),
          ),
          // reference libraries
          h(
            'div',
            { className: 'nai-s-stack', hidden: libViewShown !== 'books' },
            libInfo?.error ? h('div', { className: 'nai-s-flash', 'data-tone': 'bad', style: { margin: 0 } }, h('span', null, libInfo.error)) : null,
            h(
              'div',
              { className: 'nai-s-chips' },
              h('button', { type: 'button', className: 'nai-s-chip', 'aria-pressed': libFilter === '' ? 'true' : 'false', onClick: () => setLibFilter('') }, t('sideAllLibs')),
              knownLibs.map((name) =>
                h(
                  'button',
                  {
                    key: name,
                    type: 'button',
                    className: 'nai-s-chip',
                    'aria-pressed': libFilter === name ? 'true' : 'false',
                    'data-missing': indexedMap.has(name) ? undefined : '1',
                    title: indexedMap.has(name) ? undefined : t('sideNotIndexed'),
                    onClick: () => {
                      setLibFilter(name)
                      setLibMode('lookup')
                    }
                  },
                  name,
                  h('span', { className: 'nai-s-chip-n' }, indexedMap.has(name) ? String(indexedMap.get(name)) : '—')
                )
              )
            ),
            seg(libMode, (mode) => {
              setLibMode(mode)
              setLibResult(null)
            }, [
              ['lookup', t('sideLookup')],
              ['resolve', t('sideResolve')]
            ]),
            h(
              'form',
              {
                className: 'nai-s-row',
                onSubmit: (event) => {
                  event.preventDefault()
                  onLibSearch()
                }
              },
              h('input', {
                className: 'nai-s-in',
                style: { flex: 1, width: 'auto' },
                placeholder: libMode === 'resolve' ? t('sideResolvePh') : t('sideLookupPh'),
                value: libQuery,
                onChange: (event) => setLibQuery(event.target.value)
              }),
              h(
                'button',
                { type: 'submit', className: 'nai-s-btn', 'data-kind': 'primary', disabled: busy === 'lib' || libQuery.trim() === '' },
                busy === 'lib' ? t('sideSearching') : t('sideSearch')
              )
            ),
            h('p', { className: 'nai-s-hint' }, libMode === 'resolve' ? t('sideResolveHint') : t('sideLookupHint')),
            indexedMap.size === 0 && !libInfo?.error ? h('div', { className: 'nai-s-empty' }, t('sideLibEmpty')) : null,
            libResult === null
              ? null
              : h('div', { className: 'nai-s-sect' }, `${t('sideHits')} ${libResult.total ?? (libResult.hits ?? []).length}`),
            libResult !== null && libResult.note ? h('p', { className: 'nai-s-hint' }, libResult.note) : null,
            libResult !== null && (libResult.hits ?? []).length === 0 ? h('div', { className: 'nai-s-empty' }, t('sideNoHits')) : null,
            (libResult?.hits ?? []).map((hit, index) => {
              const id = `${hit.library}:${hit.uid}:${index}`
              const open = libOpen[id] === true
              const tag = libMode === 'resolve' || hit.library === '同人库8.5' ? rosterTag(hit.content) : ''
              return h(
                'article',
                { key: id, className: 'nai-s-hit' },
                h(
                  'div',
                  { className: 'nai-s-hit-head' },
                  h('span', { className: 'nai-s-hit-title' }, hit.title || '—'),
                  h('span', { className: 'nai-s-hit-lib nai-s-mono' }, `${hit.library} #${hit.uid ?? '?'}`)
                ),
                hit.keys ? h('div', { className: 'nai-s-hit-keys' }, hit.keys) : null,
                h('pre', { 'data-open': open ? '1' : undefined }, hit.content),
                h(
                  'div',
                  { className: 'nai-s-hit-acts' },
                  String(hit.content ?? '').length > 240
                    ? btn(open ? t('sideCollapse') : t('sideExpand'), () => setLibOpen((prev) => ({ ...prev, [id]: !open })), { size: 's', kind: 'ghost' })
                    : null,
                  h('span', { className: 'nai-s-sp' }),
                  tag
                    ? btn(t('sideInsertTag'), () => {
                        appendPrompt(tag)
                        setNotice(t('sideInserted'))
                      }, { size: 's' })
                    : null,
                  btn(pickedRefs.some((row) => row.key === refKey(hit)) ? t('sideRefUnpick') : t('sideRefPick'), () => togglePickedRef(hit), {
                    size: 's',
                    pressed: pickedRefs.some((row) => row.key === refKey(hit)) ? 'true' : 'false',
                    title: t('sideRefPickHint')
                  }),
                  btn(t('sideCopy'), () => {
                    copyTextToClipboard(String(hit.content ?? ''))
                      .then(() => setNotice(t('sideCopied')))
                      .catch((err) => setError(err.message))
                  }, { size: 's' })
                )
              )
            }),
            indexCard()
          ),
          // character DNA
          h(
            'div',
            { className: 'nai-s-stack', hidden: libViewShown !== 'chars' },
            charDoc?.error ? h('div', { className: 'nai-s-flash', 'data-tone': 'bad', style: { margin: 0 } }, h('span', null, charDoc.error)) : null,
            h(
              'div',
              { className: 'nai-s-row' },
              h('input', { className: 'nai-s-in', type: 'search', style: { flex: 1, width: 'auto' }, placeholder: t('sideCharSearch'), value: charQuery, onChange: (event) => setCharQuery(event.target.value) }),
              btn(`＋ ${t('sideCharNew')}`, () => {
                setAiEditText('')
                setAiEditNote('')
                setCharEdit(newCharDraft())
              }, { kind: 'primary', size: 's' })
            ),
            h(
              'div',
              { className: 'nai-s-row' },
              btn(t('sideDnaFromImage'), () => setDnaOpen((open) => !open), { size: 's', pressed: dnaOpen ? 'true' : 'false' }),
              btn(`＋ ${t('sideGroupNew')}`, () => setGroupEdit({ name: '' }), { kind: 'ghost', size: 's' }),
              h('span', { className: 'nai-s-sp' }),
              btn(t('sideImport'), () => charImportInput.current?.click(), { kind: 'ghost', size: 's' }),
              h('a', { className: 'nai-s-btn', 'data-kind': 'ghost', 'data-size': 's', href: `${API}/characters/export`, download: 'nai-characters.json' }, t('sideExport')),
              h('input', { ref: charImportInput, type: 'file', accept: 'application/json,.json', hidden: true, onChange: onCharImport })
            ),
            groupEdit !== null
              ? h(
                  'form',
                  {
                    className: 'nai-s-row',
                    onSubmit: (event) => {
                      event.preventDefault()
                      if (String(groupEdit.name).trim() === '') return
                      charCall('/characters/group', { group: { ...groupEdit, name: String(groupEdit.name).trim() } }, () => setGroupEdit(null))
                    }
                  },
                  h('input', { className: 'nai-s-in', style: { flex: 1, width: 'auto' }, autoFocus: true, placeholder: t('sideGroupName'), value: groupEdit.name, onChange: (event) => setGroupEdit({ ...groupEdit, name: event.target.value }) }),
                  h('button', { type: 'submit', className: 'nai-s-btn', 'data-kind': 'primary', 'data-size': 's' }, t('save')),
                  btn(t('sideCancel'), () => setGroupEdit(null), { kind: 'ghost', size: 's' })
                )
              : null,

            // 从图片生成角色 DNA
            dnaOpen
              ? h(
                  'div',
                  { className: 'nai-s-editor' },
                  h('div', { className: 'nai-s-editor-title' }, t('sideDnaFromImage')),
                  h(
                    'div',
                    {
                      className: 'nai-s-drop',
                      role: 'button',
                      tabIndex: 0,
                      'data-drop': dnaDrop ? '1' : undefined,
                      onClick: () => dnaFileInput.current?.click(),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          dnaFileInput.current?.click()
                        }
                      },
                      onDragOver: (event) => {
                        event.preventDefault()
                        setDnaDrop(true)
                      },
                      onDragLeave: () => setDnaDrop(false),
                      onDrop: (event) => {
                        event.preventDefault()
                        setDnaDrop(false)
                        const file = imageFromTransfer(event.dataTransfer)
                        if (file) takeDnaImage(file)
                      },
                      onPaste: (event) => {
                        const file = imageFromTransfer(event.clipboardData)
                        if (file) takeDnaImage(file)
                      }
                    },
                    dnaImage !== null ? h('img', { src: dnaImage.dataUrl, alt: dnaImage.name }) : null,
                    h('span', null, dnaImage !== null ? t('sideDnaChange') : t('sideDnaDrop'))
                  ),
                  h('input', {
                    ref: dnaFileInput,
                    type: 'file',
                    accept: 'image/png,image/jpeg,image/webp,image/gif',
                    hidden: true,
                    onChange: (event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) takeDnaImage(file)
                    }
                  }),
                  h('textarea', { className: 'nai-s-in', rows: 2, placeholder: t('sideDnaHintPh'), value: dnaHint, onChange: (event) => setDnaHint(event.target.value) }),
                  visionOff ? h('p', { className: 'nai-s-hint', style: { color: 'var(--warn)' } }, t('sideVisionOff')) : h('p', { className: 'nai-s-hint' }, t('sideDnaHelp')),
                  h(
                    'div',
                    { className: 'nai-s-row' },
                    btn(busy === 'dna' ? t('sideDnaRunning') : t('sideDnaRun'), onDnaFromImage, { kind: 'primary', size: 's', disabled: busy === 'dna' || dnaImage === null || llmInfo?.available === false }),
                    btn(t('sideCancel'), () => setDnaOpen(false), { kind: 'ghost', size: 's' })
                  )
                )
              : null,

            // character editor
            charEdit !== null
              ? h(
                  'div',
                  { className: 'nai-s-editor' },
                  h('div', { className: 'nai-s-editor-title' }, charEdit.id ? t('sideCharEdit') : t('sideCharNew'), charEdit.notes ? h('span', { className: 'nai-s-badge' }, t('sideDnaDraft')) : null),
                  charEdit.notes ? h('p', { className: 'nai-s-hint' }, charEdit.notes) : null,
                  charEdit.id
                    ? (() => {
                        const saved = (charDoc?.characters ?? []).find((row) => row.id === charEdit.id) ?? charEdit
                        const variants = (saved.variableFeatures ?? []).map((variant, at) => ({ variant, at })).filter(({ variant }) => wbPromptTags(variant.prompt) !== '')
                        return h(
                          'div',
                          { className: 'nai-s-cover' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'nai-s-cover-art',
                              'aria-label': saved.hasCover ? t('sideCharPreview') : t('sideCharRef'),
                              onClick: saved.hasCover ? () => openCharacterPreview(saved.id) : undefined,
                              disabled: !saved.hasCover
                            },
                            saved.hasCover
                              ? h('img', { src: `${API}/character-image?id=${encodeURIComponent(saved.id)}&v=${encodeURIComponent(saved.coverVersion ?? '')}`, alt: '' })
                              : h('span', { className: 'nai-s-swatch', 'data-blank': '1' }, t('sideCharRefNone')),
                            saved.hasCover
                              ? [
                                  h('span', { key: 'scrim', className: 'nai-s-cover-scrim' }),
                                  h(
                                    'span',
                                    { key: 'text', className: 'nai-s-cover-text' },
                                    h('span', { className: 'nai-s-cover-title' }, saved.name),
                                    h('span', { className: 'nai-s-cover-sub' }, [wbPromptTags(saved.fixedFeatures).slice(0, 60) || null, saved.coverVersion ? new Date(saved.coverVersion).toLocaleDateString() : null].filter(Boolean).join(' · '))
                                  ),
                                  h('span', { key: 'zoom', className: 'nai-s-cover-zoom' }, '⤢')
                                ]
                              : null
                          ),
                          h(
                            'div',
                            { className: 'nai-s-cover-body' },
                            h(
                              'div',
                              { className: 'nai-s-row' },
                              variants.length > 0
                                ? h(
                                    'select',
                                    { className: 'nai-s-in', style: { width: 'auto', maxWidth: '52%', height: 26 }, value: charRefVariant, onChange: (event) => setCharRefVariant(event.target.value) },
                                    h('option', { value: '' }, t('sideCharRefVariantNone')),
                                    variants.map(({ variant, at }) => h('option', { key: at, value: String(at) }, variant.name || `#${at + 1}`))
                                  )
                                : null,
                              h(
                                'label',
                                { className: 'nai-s-check-inline' },
                                h('input', { type: 'checkbox', checked: charRefArtist, onChange: (event) => setCharRefArtist(event.target.checked) }),
                                t('sideCharRefArtist')
                              )
                            ),
                            h(
                              'div',
                              { className: 'nai-s-row' },
                              btn(busy === `charprev:${saved.id}` ? `${t('sideCharRefRunning')} ${elapsed}s` : t('sideCharRefGen'), () => onCharPreview(saved.id, { variant: charRefVariant, useArtist: charRefArtist }), {
                                kind: 'primary',
                                size: 's',
                                disabled: busy !== ''
                              }),
                              shots[0] ? btn(t('sideCharRefLatest'), () => charCall('/characters/cover', { id: saved.id, from: shots[0].name }), { kind: 'ghost', size: 's' }) : null,
                              saved.hasCover ? btn(t('sideCharRefRemove'), () => charCall('/characters/cover/delete', { id: saved.id }), { kind: 'ghost', size: 's' }) : null
                            ),
                            h('p', { className: 'nai-s-hint' }, t('sideCharRefHint'))
                          )
                        )
                      })()
                    : null,
                  h(
                    'div',
                    { className: 'nai-s-grid' },
                    h('label', { className: 'nai-s-field' }, h('span', { className: 'nai-s-label' }, t('sideCharName')), h('input', { className: 'nai-s-in', value: charEdit.name, onChange: (event) => setCharEdit({ ...charEdit, name: event.target.value }) })),
                    h(
                      'label',
                      { className: 'nai-s-field' },
                      h('span', { className: 'nai-s-label' }, t('sideCharGroup')),
                      h('select', { className: 'nai-s-in', value: charEdit.groupId, onChange: (event) => setCharEdit({ ...charEdit, groupId: event.target.value }) }, (charDoc?.groups ?? []).map((group) => h('option', { key: group.id, value: group.id }, group.name)))
                    )
                  ),
                  h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideCharKeywords')),
                    h('input', { className: 'nai-s-in', placeholder: 'miku, 初音, /hatsune\\s*miku/i', value: charEdit.keywordsText, onChange: (event) => setCharEdit({ ...charEdit, keywordsText: event.target.value }) }),
                    h('span', { className: 'nai-s-hint' }, t('sideCharKeywordsHint'))
                  ),
                  h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideCharDna')),
                    h('textarea', { className: 'nai-s-in nai-s-mono', rows: 4, spellCheck: false, value: charEdit.fixedFeatures, onChange: (event) => setCharEdit({ ...charEdit, fixedFeatures: event.target.value }) }),
                    h('span', { className: 'nai-s-hint' }, t('sideCharDnaHint'))
                  ),
                  h(
                    'div',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideCharAiEdit')),
                    h('textarea', {
                      className: 'nai-s-in',
                      rows: 2,
                      placeholder: t('sideCharAiPh'),
                      value: aiEditText,
                      onChange: (event) => setAiEditText(event.target.value)
                    }),
                    h(
                      'div',
                      { className: 'nai-s-row' },
                      btn(busy === 'aiedit' ? t('sideCharAiRunning') : t('sideCharAiRun'), onAiEditCharacter, {
                        kind: 'primary',
                        size: 's',
                        disabled: busy === 'aiedit' || String(aiEditText).trim() === '' || llmInfo?.available === false
                      })
                    ),
                    aiEditNote !== ''
                      ? h('p', { className: 'nai-s-hint' }, aiEditNote)
                      : h(
                          'span',
                          { className: 'nai-s-hint' },
                          llmInfo?.available === false ? `${t('sideLlmOff')}：${llmInfo.reason ?? ''}` : t('sideCharAiHint')
                        )
                  ),
                  h('div', { className: 'nai-s-label' }, t('sideCharVariable')),
                  (charEdit.variableFeatures ?? []).map((row, index) =>
                    h(
                      'div',
                      { key: index, className: 'nai-s-varrow' },
                      h('input', {
                        className: 'nai-s-in',
                        placeholder: t('sideCharVarName'),
                        value: row.name,
                        onChange: (event) => setCharEdit({ ...charEdit, variableFeatures: charEdit.variableFeatures.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)) })
                      }),
                      h('textarea', {
                        className: 'nai-s-in nai-s-mono',
                        rows: 2,
                        spellCheck: false,
                        placeholder: t('sideCharVarPrompt'),
                        value: row.prompt,
                        onChange: (event) => setCharEdit({ ...charEdit, variableFeatures: charEdit.variableFeatures.map((item, at) => (at === index ? { ...item, prompt: event.target.value } : item)) })
                      }),
                      btn('×', () => setCharEdit({ ...charEdit, variableFeatures: charEdit.variableFeatures.filter((_, at) => at !== index) }), { kind: 'ghost', size: 's', title: t('sideRemove') })
                    )
                  ),
                  h('div', null, btn(`＋ ${t('sideCharVarAdd')}`, () => setCharEdit({ ...charEdit, variableFeatures: [...(charEdit.variableFeatures ?? []), { name: '', prompt: '' }] }), { kind: 'ghost', size: 's' })),
                  h(
                    'label',
                    { className: 'nai-s-field' },
                    h('span', { className: 'nai-s-label' }, t('sideCharNegative')),
                    h('input', { className: 'nai-s-in nai-s-mono', spellCheck: false, value: charEdit.negative ?? '', onChange: (event) => setCharEdit({ ...charEdit, negative: event.target.value }) })
                  ),
                  h(
                    'div',
                    { className: 'nai-s-row' },
                    h(
                      'label',
                      { className: 'nai-s-check-inline' },
                      h('input', {
                        type: 'checkbox',
                        checked: charEdit.matchOverrides !== null && charEdit.matchOverrides !== undefined,
                        onChange: (event) => setCharEdit({ ...charEdit, matchOverrides: event.target.checked ? { caseSensitive: false, matchWholeWords: false } : null })
                      }),
                      t('sideCharOwnRules')
                    ),
                    charEdit.matchOverrides
                      ? [
                          h(
                            'label',
                            { key: 'cs', className: 'nai-s-check-inline' },
                            h('input', { type: 'checkbox', checked: charEdit.matchOverrides.caseSensitive === true, onChange: (event) => setCharEdit({ ...charEdit, matchOverrides: { ...charEdit.matchOverrides, caseSensitive: event.target.checked } }) }),
                            t('sideCharCase')
                          ),
                          h(
                            'label',
                            { key: 'ww', className: 'nai-s-check-inline' },
                            h('input', { type: 'checkbox', checked: charEdit.matchOverrides.matchWholeWords === true, onChange: (event) => setCharEdit({ ...charEdit, matchOverrides: { ...charEdit.matchOverrides, matchWholeWords: event.target.checked } }) }),
                            t('sideCharWhole')
                          )
                        ]
                      : null
                  ),
                  h(
                    'div',
                    { className: 'nai-s-row' },
                    btn(t('save'), onSaveCharacter, { kind: 'primary', size: 's', disabled: busy === 'char:/characters/save' }),
                    btn(t('sideCancel'), () => setCharEdit(null), { kind: 'ghost', size: 's' }),
                    h('span', { className: 'nai-s-sp' }),
                    charEdit.id
                      ? btn(confirmKey === `char:${charEdit.id}` ? t('sideConfirmDelete') : t('keyRemove'), () => confirmThen(`char:${charEdit.id}`, () => charCall('/characters/delete', { id: charEdit.id }, () => setCharEdit(null))), { kind: 'danger', size: 's' })
                      : null
                  )
                )
              : null,

            // character list by group
            (charDoc?.groups ?? []).length === 0 && charDoc !== null && !charDoc.error ? h('div', { className: 'nai-s-empty' }, t('sideCharEmpty')) : null,
            h(
              'div',
              { className: 'nai-s-chars' },
              (charDoc?.groups ?? []).map((group) => {
                const q = charQuery.trim().toLowerCase()
                const rows = charList.filter(
                  (row) => row.groupId === group.id && (q === '' || `${row.name} ${(row.keywords ?? []).join(' ')} ${row.fixedFeatures}`.toLowerCase().includes(q))
                )
                if (q !== '' && rows.length === 0 && !String(group.name).toLowerCase().includes(q)) return null
                return h(
                  'section',
                  { key: group.id, className: 'nai-s-cgroup', 'data-off': group.active ? undefined : '1' },
                  h(
                    'div',
                    { className: 'nai-s-cgroup-head' },
                    h('button', {
                      type: 'button',
                      role: 'switch',
                      className: 'nai-s-switch-btn',
                      'aria-checked': group.active ? 'true' : 'false',
                      'aria-label': `${group.name} ${t('sideGroupActive')}`,
                      title: t('sideGroupActiveHint'),
                      onClick: () => charCall('/characters/group', { group: { ...group, active: !group.active } })
                    }),
                    h('strong', null, group.name),
                    h('span', { className: 'nai-s-chip-n' }, String(charList.filter((row) => row.groupId === group.id).length)),
                    btn('＋', () => setCharEdit(newCharDraft(group.id)), { kind: 'ghost', size: 's', title: t('sideCharNew') }),
                    btn('✎', () => setGroupEdit({ ...group }), { kind: 'ghost', size: 's', title: t('sideGroupRename') }),
                    (charDoc?.groups ?? []).length > 1
                      ? btn(confirmKey === `group:${group.id}` ? t('sideConfirmDelete') : '×', () => confirmThen(`group:${group.id}`, () => charCall('/characters/group/delete', { id: group.id })), { kind: 'ghost', size: 's', title: t('sideGroupDelete') })
                      : null
                  ),
                  rows.map((row) =>
                    h(
                      'article',
                      {
                        key: row.id,
                        className: 'nai-s-char',
                        'data-picked': pickedChars.includes(row.id) ? '1' : undefined,
                        style: { animationDelay: `${Math.min(rows.indexOf(row), 8) * 20}ms` }
                      },
                      h(
                        'div',
                        { className: 'nai-s-char-head' },
                        row.hasCover
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'nai-s-char-thumb',
                                'aria-label': t('sideCharPreview'),
                                title: t('sideCharPreview'),
                                onClick: () => openCharacterPreview(row.id)
                              },
                              h('img', { src: `${API}/character-image?id=${encodeURIComponent(row.id)}&v=${encodeURIComponent(row.coverVersion ?? '')}`, alt: '', loading: 'lazy' })
                            )
                          : null,
                        h('strong', null, row.name), (row.variableFeatures ?? []).length > 0 ? h('span', { className: 'nai-s-chip-n' }, `+${row.variableFeatures.length}`) : null),
                      (row.keywords ?? []).length > 0 ? h('div', { className: 'nai-s-char-keys' }, row.keywords.join(', ')) : null,
                      h('div', { className: 'nai-s-char-dna', title: row.fixedFeatures }, wbPromptTags(row.fixedFeatures) || row.fixedFeatures || t('sideCharNoDna')),
                      h(
                        'div',
                        { className: 'nai-s-char-acts' },
                        btn(t('sideCharToRow'), () => {
                          addRow(rowFromCharacter(row))
                          setSideNav('create')
                        }, { size: 's', disabled: charRows.length >= WB_MAX_CHARACTERS }),
                        (row.variableFeatures ?? []).filter((variant) => wbPromptTags(variant.prompt) !== '').map((variant) =>
                          btn(`＋${variant.name || row.variableFeatures.indexOf(variant) + 1}`, () => {
                            addRow(rowFromCharacter(row, row.variableFeatures.indexOf(variant)))
                            setSideNav('create')
                          }, { key: row.variableFeatures.indexOf(variant), kind: 'ghost', size: 's', disabled: charRows.length >= WB_MAX_CHARACTERS, title: variant.prompt })
                        ),
                        btn(pickedChars.includes(row.id) ? t('sideCharUnpick') : t('sideCharPick'), () => togglePickedChar(row.id), {
                          kind: 'ghost',
                          size: 's',
                          pressed: pickedChars.includes(row.id) ? 'true' : 'false',
                          title: t('sideCharPickHint')
                        }),
                        h('span', { className: 'nai-s-sp' }),
                        btn(busy === `charprev:${row.id}` ? `${t('sideCharRefRunning')} ${elapsed}s` : t('sideCharRefGen'), () => onCharPreview(row.id, { useArtist: true }), {
                          kind: 'ghost',
                          size: 's',
                          disabled: busy !== '',
                          title: t('sideCharRefHint')
                        }),
                        btn(t('sideCharEditShort'), () => editCharacter(row), { kind: 'ghost', size: 's' })
                      )
                    )
                  )
                )
              })
            ),
            h('p', { className: 'nai-s-hint' }, t('sideCharHowTo'))
          ),
        )

        // ------------------------------------------------------------ gallery --
        const galleryPane = h(
          'div',
          { className: 'nai-s-pane', hidden: sideNav !== 'gallery' },
          h(
            'div',
            { className: 'nai-s-row' },
            h('span', { className: 'nai-s-hint', style: { flex: 1 } }, `${galleryTotal} ${t('sideGalleryCount')}${galleryStats ? ` · ${fmtBytes(galleryStats.bytes)}` : ''}`),
            btn(t('refresh'), () => loadGallery(0, false), { kind: 'ghost', size: 's' }),
            btn(gallerySelecting ? t('sideCancel') : t('sideSelect'), () => {
              setGallerySelecting((on) => !on)
              setGallerySel([])
            }, { size: 's', pressed: gallerySelecting ? 'true' : 'false' })
          ),
          gallerySelecting
            ? h(
                'div',
                { className: 'nai-s-row' },
                btn(t('sideSelectAll'), () => setGallerySel((galleryList ?? []).map((file) => file.name)), { kind: 'ghost', size: 's' }),
                h('span', { className: 'nai-s-sp' }),
                btn(confirmKey === 'gal:sel' ? t('sideConfirmDelete') : `${t('sideDeleteSelected')} ${gallerySel.length}`, () => confirmThen('gal:sel', () => deleteRenders(gallerySel).catch(() => {})), {
                  kind: 'danger',
                  size: 's',
                  disabled: gallerySel.length === 0 || busy === 'gallery'
                })
              )
            : null,
          galleryList === null
            ? h('p', { className: 'nai-s-hint' }, t('loading'))
            : galleryList.length === 0
              ? h('div', { className: 'nai-s-empty' }, t('sideGalleryEmptyAll'))
              : h(
                  'div',
                  { className: 'nai-s-shots' },
                  galleryList.map((file) => {
                    const chosen = gallerySel.includes(file.name)
                    return h(
                      'button',
                      {
                        key: file.name,
                        type: 'button',
                        className: 'nai-s-shot nai-s-gal-tile',
                        title: file.name,
                        'aria-pressed': gallerySelecting ? (chosen ? 'true' : 'false') : undefined,
                        onClick: () =>
                          gallerySelecting
                            ? setGallerySel((list) => (list.includes(file.name) ? list.filter((name) => name !== file.name) : [...list, file.name]))
                            : openViewer(file.name, galleryList)
                      },
                      h('img', { src: fileUrl(file.name), alt: '', loading: 'lazy', [IMG_ATTR]: '1', 'data-nai-name': file.name, 'data-nai-kind': 'gallery' }),
                      gallerySelecting ? h('span', { className: 'nai-s-gal-check', 'data-on': chosen ? '1' : undefined }, chosen ? '✓' : '') : null
                    )
                  })
                ),
          galleryList !== null && galleryList.length < galleryTotal
            ? h('div', null, btn(t('loadMore'), () => loadGallery(galleryList.length, true), { size: 's' }))
            : null,
          panelCard(
            t('sideGalleryManage'),
            `${galleryTotal} · keep ${status?.keepImages ?? '—'}`,
            false,
            h('p', { className: 'nai-s-hint' }, t('sideGalleryHint')),
            h(
              'div',
              { className: 'nai-s-row' },
              h('input', {
                className: 'nai-s-in nai-s-mono',
                style: { width: 96 },
                type: 'number',
                min: 0,
                placeholder: String(status?.keepImages ?? 500),
                value: trimKeep,
                onChange: (event) => setTrimKeep(event.target.value.replace(/[^\d]/g, ''))
              }),
              btn(confirmKey === 'gal:trim' ? t('sideConfirmDelete') : t('sideTrimKeep'), () => confirmThen('gal:trim', () => onTrim()), { size: 's', disabled: trimKeep === '' || busy === 'gallery' }),
              h('span', { className: 'nai-s-sp' }),
              btn(confirmKey === 'gal:all' ? t('sideConfirmDeleteAll') : t('sideDeleteAll'), () => confirmThen('gal:all', () => onTrim(0)), { kind: 'danger', size: 's', disabled: busy === 'gallery' })
            ),
            field('keepImages', t('keepImages'), { type: 'number', min: 0, mono: true }),
            h('div', { className: 'nai-s-path' }, `${t('outputDir')}: ${galleryStats?.outputDir ?? status?.outputDir ?? ''}`)
          )
        )

        // ---------------------------------------------------------- settings --
        const failed = (doctor?.checks ?? []).filter((check) => !check.ok)
        const settingsPane = h(
          'div',
          { className: 'nai-s-pane', hidden: sideNav !== 'settings' },
          panelCard(
            t('sideConnection'),
            `${credentialOk ? t('sideTokenOk') : t('sideTokenMissing')} · ${status?.model ?? ''}`,
            true,
            h(
              'label',
              { className: 'nai-s-field' },
              h('span', { className: 'nai-s-label' }, t('token')),
              h('input', {
                className: 'nai-s-in nai-s-mono',
                type: 'password',
                autoComplete: 'off',
                placeholder: t('tokenPlaceholder'),
                value: form.token ?? '',
                onChange: set('token')
              }),
              h(
                'span',
                { className: 'nai-s-hint' },
                status?.tokenSource === 'env' ? t('tokenFromEnv') : status?.tokenSet ? t('tokenSet') : t('tokenNone')
              )
            ),
            modelPicker(),
            field('baseUrl', t('baseUrl'), { mono: true, placeholder: 'https://image.novelai.net' }),
            h('p', { className: 'nai-s-hint', style: { marginTop: -4 } }, t('sideBaseUrlHint')),
            h(
              'label',
              { className: 'nai-s-field' },
              h('span', { className: 'nai-s-label' }, t('sideDecode')),
              h(
                'select',
                { className: 'nai-s-in', value: form.decode ?? 'json', onChange: set('decode') },
                [
                  ['json', t('sideDecodeJson')],
                  ['zip', t('sideDecodeZip')],
                  ['auto', t('sideDecodeAuto')]
                ].map(([value, text]) => h('option', { key: value, value }, text))
              ),
              h('span', { className: 'nai-s-hint' }, t('sideDecodeHint'))
            ),
            h(
              'label',
              { className: 'nai-s-field' },
              h('span', { className: 'nai-s-label' }, t('proxy')),
              h('input', { className: 'nai-s-in nai-s-mono', spellCheck: false, placeholder: t('sideProxyPlaceholder'), value: form.proxy ?? '', onChange: set('proxy') }),
              h('span', { className: 'nai-s-hint' }, t('proxyHint'))
            ),
            h(
              'div',
              { className: 'nai-s-row' },
              btn(busy === 'probe' ? t('probing') : t('probe'), onProbe, { disabled: busy === 'probe' }),
              h('span', { className: 'nai-s-hint', style: { flex: 1 } }, t('probeHint'))
            ),
            h(
              'div',
              { className: 'nai-s-balance' },
              h(
                'div',
                { className: 'nai-s-row' },
                h('strong', { style: { fontSize: 12.5 } }, t('sideBalance')),
                h('span', { className: 'nai-s-sp' }),
                btn(balanceBusy ? t('loading') : t('sideBalanceRefresh'), loadBalance, { kind: 'ghost', size: 's', disabled: balanceBusy })
              ),
              balance === null
                ? h('p', { className: 'nai-s-hint' }, t('sideBalanceHint'))
                : balance.error
                  ? h('p', { className: 'nai-s-hint', style: { color: 'var(--bad)' } }, balance.error)
                  : balanceRows.map((row) =>
                      h(
                        'div',
                        { key: row.id ?? row.fingerprint, className: 'nai-s-balance-row' },
                        h('span', { className: 'nai-s-dot', 'data-ok': row.ok ? '1' : '0' }),
                        h('span', { className: 'nai-s-balance-key' }, row.label || row.fingerprint || t('sideUnnamedKey')),
                        row.ok
                          ? h(
                              'span',
                              { className: 'nai-s-mono' },
                              [energyText(row.energy), `${t('sideAnlas')} ${fmtCount(row.anlas?.total)}`, row.anlas ? `(${fmtCount(row.anlas.fixed)} + ${fmtCount(row.anlas.purchased)})` : null, row.tier !== null && row.tier !== undefined ? `tier ${row.tier}` : null]
                                .filter(Boolean)
                                .join(' · ')
                            )
                          : h('span', { className: 'nai-s-hint', style: { color: 'var(--bad)' } }, row.error ?? t('failed'))
                      )
                    )
            ),
            probed === null
              ? null
              : h(
                  'div',
                  { className: 'nai-s-flash', 'data-tone': probed.ok ? 'ok' : 'bad', style: { margin: 0 } },
                  h(
                    'span',
                    null,
                    `${probed.ok ? t('sideProbeOk') : t('sideProbeFail')}${probed.status === undefined ? '' : ` · HTTP ${probed.status}`}`,
                    probed.subscription?.tier === undefined || probed.subscription?.tier === null
                      ? null
                      : ` · tier ${probed.subscription.tier} · ${t('sideStepsLeft')} ${
                          (probed.subscription.fixedTrainingStepsLeft ?? 0) + (probed.subscription.purchasedTrainingStepsLeft ?? 0)
                        }`,
                    probed.detail ? h('span', { style: { display: 'block' } }, probed.detail) : null,
                    probed.hint ? h('span', { style: { display: 'block' } }, probed.hint) : null
                  )
                )
          ),
          panelCard(
            t('sideLlm'),
            llmInfo === null ? '…' : llmInfo.available ? `${llmInfo.model}${llmInfo.vision ? ' · 👁' : ''}` : t('sideLlmOffShort'),
            false,
            h(
              'p',
              { className: 'nai-s-hint' },
              llmInfo === null
                ? t('loading')
                : llmInfo.available
                  ? `${llmInfo.source === 'plugin' ? t('sideLlmPinned') : t('sideLlmDefault')}：${llmInfo.provider}/${llmInfo.model} · ${
                      llmInfo.vision === true ? t('sideLlmVisionYes') : llmInfo.vision === false ? t('sideLlmVisionNo') : t('sideLlmVisionUnknown')
                    }`
                  : `${t('sideLlmOff')}：${llmInfo.reason ?? ''}`
            ),
            (() => {
              const chosenProvider = String(form.llmProvider ?? '')
              const chosenModel = String(form.llmModel ?? '')
              const pending = chosenProvider !== String(status?.llmProvider ?? '') || chosenModel !== String(status?.llmModel ?? '')
              if (!pending) return null
              const entry = (llmModelList ?? []).find((p) => p.provider === chosenProvider)?.models.find((m) => m.id === chosenModel)
              const label = chosenModel === '' ? t('sideLlmFollow') : `${chosenProvider}/${chosenModel}`
              const vision = chosenModel === '' ? '' : entry?.vision ? ` · ${t('sideLlmVisionYes')}` : ` · ${t('sideLlmVisionNo')}`
              return h('p', { className: 'nai-s-hint', style: { color: 'var(--warn)' } }, `${t('sideLlmPending')}${label}${vision}`)
            })(),
            h(
              'label',
              { className: 'nai-s-field' },
              h('span', { className: 'nai-s-label' }, t('sideLlmRoute')),
              h(
                'select',
                {
                  className: 'nai-s-in',
                  value: form.llmProvider && form.llmModel ? `${form.llmProvider}\u0000${form.llmModel}` : '',
                  onChange: (event) => {
                    const [provider, model] = String(event.target.value).split('\u0000')
                    setForm((prev) => ({ ...prev, llmProvider: model ? provider : '', llmModel: model ?? '' }))
                  }
                },
                h('option', { value: '' }, t('sideLlmFollow')),
                (llmModelList ?? []).map((provider) =>
                  h(
                    'optgroup',
                    { key: provider.provider, label: provider.label },
                    provider.models.map((model) => h('option', { key: model.id, value: `${provider.provider}\u0000${model.id}` }, `${model.name}${model.vision ? '  👁' : ''}`))
                  )
                ),
                form.llmProvider && form.llmModel && !(llmModelList ?? []).some((p) => p.provider === form.llmProvider && p.models.some((m) => m.id === form.llmModel))
                  ? h('option', { value: `${form.llmProvider}\u0000${form.llmModel}` }, `${form.llmProvider}/${form.llmModel}`)
                  : null
              ),
              h('span', { className: 'nai-s-hint' }, t('sideLlmRouteHint'))
            ),
            h(
              'div',
              { className: 'nai-s-grid' },
              field('llmMaxTokens', t('sideLlmMaxTokens'), { type: 'number', min: 256, step: 256, mono: true }),
              field('writerRetries', t('sideLlmRetries'), { type: 'number', min: 0, max: 5, mono: true })
            ),
            h('div', { className: 'nai-s-row' }, btn(t('refresh'), () => {
              loadLlm()
              loadLlmModels()
            }, { kind: 'ghost', size: 's' }))
          ),
          panelCard(
            t('sidePresets'),
            presetData?.error ? t('failed') : t('sidePresetsSum'),
            false,
            presetData?.error
              ? h('p', { className: 'nai-s-hint', style: { color: 'var(--bad)' } }, presetData.error)
              : presetDraft === null
                ? h('p', { className: 'nai-s-hint' }, t('loading'))
                : [
                    h('div', { key: 'seg' }, seg(presetTab, setPresetTab, [['write', t('sidePresetWrite')], ['dna', t('sidePresetDna')]])),
                    h('p', { key: 'hint', className: 'nai-s-hint' }, presetTab === 'write' ? t('sidePresetWriteHint') : t('sidePresetDnaHint')),
                    ['system', 'user'].map((part) =>
                      h(
                        'label',
                        { key: part, className: 'nai-s-field' },
                        h('span', { className: 'nai-s-label' }, part === 'system' ? t('sidePresetSystem') : t('sidePresetUser')),
                        h('textarea', {
                          className: 'nai-s-in nai-s-mono',
                          rows: part === 'system' ? 10 : 6,
                          spellCheck: false,
                          value: String(presetDraft?.[presetTab]?.[part] ?? ''),
                          onChange: (event) =>
                            setPresetDraft((prev) => ({ ...(prev ?? {}), [presetTab]: { ...(prev?.[presetTab] ?? {}), [part]: event.target.value } }))
                        })
                      )
                    ),
                    h(
                      'div',
                      { key: 'acts', className: 'nai-s-row' },
                      btn(t('save'), onPresetSave, {
                        kind: 'primary',
                        size: 's',
                        disabled: busy === 'presets' || JSON.stringify(presetDraft) === JSON.stringify(presetData?.presets ?? {})
                      }),
                      btn(t('sidePresetDiscard'), () => setPresetDraft(JSON.parse(JSON.stringify(presetData?.presets ?? {}))), { kind: 'ghost', size: 's' }),
                      h('span', { className: 'nai-s-sp' }),
                      btn(t('sidePresetReset'), () => onPresetReset(presetTab), { kind: 'ghost', size: 's', disabled: busy === 'presets' })
                    )
                  ]
          ),
          h(
            'details',
            { ref: logCardRef, className: 'nai-s-card' },
            h(
              'summary',
              null,
              h('span', { className: 'nai-s-card-title' }, t('sideLog')),
              h(
                'span',
                { className: 'nai-s-card-sum nai-s-mono' },
                logData?.entries
                  ? `${logData.entries.length} ${t('sideLogItems')}${logData.entries.some((row) => row.level === 'error') ? ` · ${logData.entries.filter((row) => row.level === 'error').length} ${t('sideLogErrors')}` : ''}`
                  : ''
              )
            ),
            h(
              'div',
              { className: 'nai-s-card-body' },
              h('p', { className: 'nai-s-hint' }, t('sideLogHint')),
              h(
                'div',
                { className: 'nai-s-row' },
                [['all', t('sideLogAll')], ['write', t('sideLogWrite')], ['render', t('sideLogRender')], ['dna', t('sideLogDna')], ['character', t('sideLogCharacter')], ['error', t('sideLogErrorsOnly')]].map(([key, text]) =>
                  h('button', { key, type: 'button', className: 'nai-s-chip', 'aria-pressed': logFilter === key ? 'true' : 'false', onClick: () => setLogFilter(key) }, text)
                )
              ),
              logData?.error
                ? h('p', { className: 'nai-s-hint', style: { color: 'var(--bad)' } }, logData.error)
                : !logData || logData.entries.length === 0
                  ? h('div', { className: 'nai-s-empty' }, logBusy ? t('loading') : t('sideLogEmpty'))
                  : h(
                      'div',
                      { className: 'nai-s-loglist' },
                      logData.entries.map((entry) =>
                        h(
                          'div',
                          { key: entry.id, className: 'nai-s-logrow', 'data-level': entry.level, 'data-log-id': entry.id, 'data-open': logOpenId === entry.id ? '1' : undefined },
                          h(
                            'button',
                            { type: 'button', className: 'nai-s-logrow-head', 'aria-expanded': logOpenId === entry.id ? 'true' : 'false', onClick: () => setLogOpenId(logOpenId === entry.id ? '' : entry.id) },
                            h('span', { className: 'nai-s-logrow-time nai-s-mono' }, wbLogTime(entry.at)),
                            h('span', { className: 'nai-s-logrow-event' }, t(`sideLogEvent_${entry.event}`) === `sideLogEvent_${entry.event}` ? entry.event : t(`sideLogEvent_${entry.event}`)),
                            h('span', { className: 'nai-s-logrow-sum' }, entry.summary || entry.message || '')
                          ),
                          logOpenId === entry.id
                            ? h(
                                'div',
                                { className: 'nai-s-logrow-body' },
                                h('pre', { className: 'nai-s-logjson' }, JSON.stringify(entry, null, 2)),
                                h('div', null, btn(t('sideCopy'), () => copyTextToClipboard(JSON.stringify(entry, null, 2)).then(() => setNotice(t('sideCopied'))).catch(() => {}), { kind: 'ghost', size: 's' }))
                              )
                            : null
                        )
                      )
                    ),
              h(
                'div',
                { className: 'nai-s-row' },
                btn(logBusy ? t('loading') : t('refresh'), () => loadLogs(logFilter), { kind: 'ghost', size: 's', disabled: logBusy }),
                h('a', { className: 'nai-s-btn', 'data-kind': 'ghost', 'data-size': 's', href: `${API}/logs/download?day=${new Date().toLocaleDateString('sv-SE')}`, download: '' }, t('sideLogDownload')),
                h('span', { className: 'nai-s-sp' }),
                btn(confirmKey === 'logs:clear' ? t('sideConfirmDelete') : t('sideLogClear'), () => confirmThen('logs:clear', onClearLogs), { kind: 'danger', size: 's', disabled: logBusy })
              ),
              logData?.dir ? h('div', { className: 'nai-s-path' }, `${t('sideLogDir')}: ${logData.dir}`) : null,
              Array.isArray(logData?.days) && logData.days.length > 0
                ? h('p', { className: 'nai-s-hint nai-s-mono' }, logData.days.slice(0, 7).map((day) => `${day.day} ${day.count}`).join(' · '))
                : null
            )
          ),
          panelCard(
            t('keys'),
            keySum ? `${keySum.usableKeyCount}/${keySum.keyCount} · ${t('concurrency')} ${keySum.concurrency}` : '',
            false,
            h('p', { className: 'nai-s-hint' }, t('sideKeysHint')),
            (status?.keys ?? []).length === 0
              ? null
              : h(
                  'div',
                  null,
                  (status?.keys ?? []).map((key) =>
                    h(
                      'div',
                      { key: key.id, className: 'nai-s-keyrow' },
                      h('span', {
                        className: 'nai-s-dot',
                        'data-ok': !key.enabled ? '0' : key.status === 'healthy' ? '1' : key.status === 'cooldown' ? 'w' : undefined
                      }),
                      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, key.label || t('sideUnnamedKey')),
                      h(
                        'span',
                        { className: 'nai-s-keyrow-acts' },
                        btn(key.enabled ? t('keyDisable') : t('keyEnable'), () => onKeyAction('/keys/update', { id: key.id, enabled: !key.enabled }), { size: 's' }),
                        btn(t('keyRemove'), () => onKeyAction('/keys/remove', { id: key.id }), { size: 's', kind: 'danger' })
                      ),
                      h(
                        'span',
                        { className: 'nai-s-mono', style: { color: 'var(--ink3)' } },
                        `${key.fingerprint} · ${key.status}${key.completed > 0 ? ` · ${key.completed}` : ''}${
                          key.subscription?.tier !== null && key.subscription?.tier !== undefined ? ` · tier ${key.subscription.tier}` : ''
                        }`
                      )
                    )
                  )
                ),
            (keySum?.keyIssues ?? []).map((issue) =>
              h('p', { key: issue.id, className: 'nai-s-hint', style: { color: 'var(--bad)' } }, `${issue.label}：${issue.error}`)
            ),
            h(
              'div',
              { className: 'nai-s-grid' },
              h('input', { className: 'nai-s-in', placeholder: t('keyLabel'), value: newLabel, onChange: (event) => setNewLabel(event.target.value) }),
              h('input', {
                className: 'nai-s-in nai-s-mono',
                type: 'password',
                autoComplete: 'off',
                placeholder: 'pst-…',
                value: newToken,
                onChange: (event) => setNewToken(event.target.value)
              })
            ),
            h(
              'div',
              { className: 'nai-s-row' },
              btn(t('keyAdd'), () => onKeyAction('/keys/add', { label: newLabel, token: newToken }), {
                kind: 'primary',
                disabled: busy === 'key:/keys/add' || newToken.trim() === ''
              }),
              btn(t('keyVerify'), () => onKeyAction('/keys/verify', {}), { disabled: busy === 'key:/keys/verify' })
            )
          ),
          panelCard(
            t('sideChat'),
            `${t('sideCodeBtnShort')} ${onOff(status?.codeButtons === true)} · ${t('sideAutoShort')} ${onOff(status?.autoGenerate === true)}`,
            false,
            switchRow(t('sideCodeBtn'), t('codeButtonsHint'), status?.codeButtons === true, onToggleCodeButtons, busy === 'codeButtons'),
            switchRow(t('sideAuto'), t('autoHint'), status?.autoGenerate === true, onToggleAuto, busy === 'auto'),
            h('p', { className: 'nai-s-hint' }, t('inlineHint'))
          ),
          hasBooks ? null : indexCard(),
          panelCard(
            t('sideDirs'),
            `×${form.maxImagesPerCall ?? '—'} · keep ${form.keepImages ?? '—'}`,
            false,
            field('outputDir', t('outputDir'), { mono: true }),
            field('sourceDir', t('sideSourceDir'), { mono: true, placeholder: status?.sourceDir ?? '' }),
            h(
              'div',
              { className: 'nai-s-grid' },
              field('maxImagesPerCall', t('guard'), { type: 'number', min: 1, max: 16, mono: true }),
              field('keepImages', t('keepImages'), { type: 'number', min: 0, mono: true })
            ),
            h('p', { className: 'nai-s-hint' }, t('sideDirsHint'))
          ),
          panelCard(
            t('sideHealth'),
            doctor === null ? t('sideHealthIdle') : failed.length === 0 ? t('sideHealthOk') : `${failed.length} ${t('sideHealthFail')}`,
            false,
            h('p', { className: 'nai-s-hint' }, t('sideHealthHint')),
            h('div', null, btn(busy === 'doctor' ? t('sideHealthRunning') : t('sideHealthRun'), onDoctor, { disabled: busy === 'doctor' })),
            doctor === null
              ? null
              : h(
                  'div',
                  { className: 'nai-s-checks' },
                  [...failed, ...(doctor.checks ?? []).filter((check) => check.ok)].map((check, index) =>
                    h(
                      'div',
                      { key: `${index}:${check.name}`, className: 'nai-s-check' },
                      h('span', { className: 'nai-s-dot', 'data-ok': check.ok ? '1' : '0' }),
                      h(
                        'span',
                        { className: 'nai-s-check-name' },
                        check.name,
                        !check.ok && check.detail ? h('span', { className: 'nai-s-check-detail' }, String(check.detail).slice(0, 220)) : null
                      )
                    )
                  )
                )
          )
        )

        // ------------------------------------------------------------- frame --
        const navItems = [
          ['create', t('sideNavCreate')],
          ['edit', t('sideNavEdit')],
          ['gallery', t('sideNavGallery')],
          ['library', t('sideNavLibrary')],
          ['settings', t('sideNavSettings')]
        ]
        const sideFrame = h(
          'div',
          { className: 'nai-s' },
          h(
            'div',
            { className: 'nai-s-head' },
            h(
              'button',
              { type: 'button', className: 'nai-s-status', title: t('sideNavSettings'), onClick: () => setSideNav('settings') },
              h('span', { className: 'nai-s-dot', 'data-ok': status === null ? undefined : credentialOk ? '1' : '0' }),
              h(
                'span',
                { className: 'nai-s-status-txt' },
                credentialOk ? t('sideTokenOk') : t('sideTokenMissing'),
                ' · ',
                h(
                  'span',
                  { className: 'nai-s-mono' },
                  `${status?.model ?? ''}${keySum && keySum.keyCount > 1 ? ` · ${keySum.usableKeyCount} keys` : ''}${
                    balanceFirst ? `${balanceFirst.energy && !balanceFirst.energy.unavailable ? ` · ⚡${balanceFirst.energy.percent}%` : ''} · ${fmtCount(balanceFirst.anlas?.total)} Anlas` : ''
                  }`
                )
              )
            ),
            h(
              'div',
              { className: 'nai-s-nav', role: 'tablist' },
              navItems.map(([key, text]) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    role: 'tab',
                    className: 'nai-s-tab',
                    'aria-selected': sideNav === key ? 'true' : 'false',
                    onClick: () => setSideNav(key)
                  },
                  text
                )
              )
            )
          ),
          error
            ? h(
                'div',
                { className: 'nai-s-flash', 'data-tone': 'bad', role: 'alert' },
                h('span', null, error),
                errorLog && errorLog.message === error ? h('button', { type: 'button', className: 'nai-s-flash-link', onClick: () => openLogEntry(errorLog.id) }, t('sideLogOpen')) : null,
                h('button', { type: 'button', 'aria-label': '×', onClick: () => { setError(''); setErrorLog(null) } }, '×')
              )
            : null,
          notice ? h('div', { className: 'nai-s-flash', 'data-tone': 'ok', role: 'status' }, h('span', null, notice)) : null,
          rendering
            ? h(
                'div',
                { className: 'nai-s-flash', 'data-tone': 'busy', role: 'status' },
                h(
                  'span',
                  null,
                  [
                    `${t('sideRenderWaiting')} ${elapsed}s`,
                    renderProgress && renderProgress.received > 0
                      ? ` · ${t('sideRenderReceived')} ${formatBytes(renderProgress.received)}${renderProgress.total ? ` / ${formatBytes(renderProgress.total)}` : ''}`
                      : '',
                    elapsed >= 25 ? ` · ${t('sideRenderSlow')}` : ''
                  ].join('')
                ),
                h('button', { type: 'button', onClick: onCancelRender }, t('sideCancel'))
              )
            : null,
          h('div', { className: 'nai-s-body' }, createPane, editPane, galleryPane, libraryPane, settingsPane),
          dirty
            ? h(
                'div',
                { className: 'nai-s-savebar' },
                // Save sits on the left: the shell's floating launcher covers the bottom-right corner.
                btn(busy === 'save' ? t('saving') : t('save'), onSave, { kind: 'primary', disabled: busy === 'save' }),
                btn(t('sideDiscard'), () => setForm({ ...baseline, token: '' }), { kind: 'ghost', size: 's', disabled: baseline === null }),
                h('span', null, t('sideUnsaved'))
              )
            : null,
          h('input', { ref: fileInput, type: 'file', accept: 'image/png,image/jpeg,image/webp', onChange: onFileChosen, hidden: true }),
          h('datalist', { id: 'nai-s-samplers' }, SAMPLERS.map((name) => h('option', { key: name, value: name }))),
          h('datalist', { id: 'nai-s-models' }, MODELS.map((name) => h('option', { key: name, value: name }))),
          sourcePickerModal,
          galleryPickerModal
        )
        // 侧栏位置原样铺满；插件页位置居中限宽，读起来仍像一栏而不是被拉宽的表单。
        return props.layout === 'side'
          ? sideFrame
          : h(
              'div',
              {
                style: {
                  height: '100%',
                  maxWidth: 960,
                  margin: '0 auto',
                  borderLeft: '1px solid var(--line-soft)',
                  borderRight: '1px solid var(--line-soft)'
                }
              },
              sideFrame
            )
      }

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            padding: '20px 24px 40px',
            boxSizing: 'border-box',
            fontSize: 13,
            lineHeight: '20px'
          }
        },
        h('div', { style: { fontSize: 18, fontWeight: 600 } }, t('title')),
        h('div', { style: { ...label, marginTop: 4 } }, t('subtitle')),

        error ? h('div', { style: { ...card, color: '#c62828' } }, `${t('failed')}：${error}`) : null,
        notice ? h('div', { style: { ...card, color: '#2e7d32' } }, notice) : null,

        // ---- credential + connection -------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('credentials'))),
        h(
          'div',
          { style: row },
          h(
            'div',
            { style: cell(2) },
            h('label', { style: label }, t('token')),
            h('input', {
              type: 'password',
              style: input,
              placeholder: t('tokenPlaceholder'),
              value: form.token ?? '',
              onChange: set('token')
            }),
            h(
              'div',
              { style: { ...label, marginTop: 4 } },
              status?.tokenSource === 'env'
                ? t('tokenFromEnv')
                : status?.tokenSet
                  ? t('tokenSet')
                  : t('tokenNone')
            )
          ),
          textField('baseUrl', t('baseUrl')),
          textField('model', t('model'))
        ),

        // ---- sampling defaults -------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('defaults'))),
        h(
          'div',
          { style: row },
          numericField('width', t('width'), 64),
          numericField('height', t('height'), 64),
          numericField('steps', t('steps')),
          numericField('scale', t('scale'), 0.1),
          numericField('ucPreset', t('ucPreset')),
          numericField('sampler', t('sampler'))
        ),
        // 档位说明单列一行。手填数字时它才让人不必猜「2 是谁」，
        // 但只写分类名，不断言两版正文相同（light 一档两版不同）。
        h('div', { style: { ...row, marginTop: 2 } }, hintField('ucPresetHint', t('ucPreset'), t('ucPresetHint'))),
        // 头部插入单独占一行：它要么是空，要么是一串标签，放在半列里不够写。
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          textField('header', t('header'), 'fur dataset'),
          hintField('headerHint', t('header'), t('headerHint'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(2) },
            h('label', { style: label }, t('sideDecode')),
            h(
              'select',
              { style: input, value: form.decode ?? 'json', onChange: set('decode') },
              [
                ['json', t('sideDecodeJson')],
                ['zip', t('sideDecodeZip')],
                ['auto', t('sideDecodeAuto')]
              ].map(([value, text]) => h('option', { key: value, value }, text))
            )
          ),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('sideDecodeHint'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          textField('proxy', t('proxy')),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('proxyHint'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(4) },
            h('label', { style: label }, t('negative')),
            h('textarea', {
              style: { ...input, height: 56, padding: 8, resize: 'vertical', fontFamily: 'inherit' },
              value: form.negativePrompt ?? '',
              onChange: set('negativePrompt')
            })
          )
        ),
        heavy ? h('div', { style: { ...label, marginTop: 6, color: '#e08b00' } }, t('heaviest')) : null,

        // ---- paths + guards ----------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('paths'))),
        h(
          'div',
          { style: row },
          textField('outputDir', t('outputDir')),
          numericField('maxImagesPerCall', t('guard')),
          numericField('keepImages', t('keepImages'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          textField('libraryDir', t('libraryDir')),
          textField('librarySourceDir', t('librarySourceDir'))
        ),
        h(
          'div',
          { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            { type: 'button', style: button(true), onClick: onSave, disabled: busy === 'save' },
            busy === 'save' ? t('saving') : t('save')
          ),
          h('div', { style: label }, `${t('libraries')}：${(status?.libraries ?? []).map((row) => `${row.library}(${row.entries})`).join('、') || '—'}`)
        ),

        // ---- key pool -----------------------------------------------------
        h(
          'div',
          { style: section },
          h('div', { style: { fontWeight: 600 } }, t('keys')),
          h(
            'div',
            { style: { ...label, marginTop: 4 } },
            status?.keySummary
              ? `${status.keySummary.keyCount} 个 · 可用 ${status.keySummary.usableKeyCount} · 空闲 ${status.keySummary.availableKeyCount} · ${t('concurrency')} ${status.keySummary.concurrency}` +
                (status.keySummary.queuedCount > 0 ? ` · 队列 ${status.keySummary.queuedCount}` : '') +
                (status.keySummary.activeCount > 0 ? ` · 在飞 ${status.keySummary.activeCount}` : '')
              : ''
          ),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            (status?.keys ?? []).map((key) =>
              h(
                'div',
                { key: key.id, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
                h('span', {
                  style: {
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    flex: 'none',
                    background: !key.enabled
                      ? '#c62828'
                      : key.status === 'healthy'
                        ? '#2e7d32'
                        : key.status === 'cooldown'
                          ? '#e08b00'
                          : '#9e9e9e'
                  }
                }),
                h('span', { style: { flex: 'none', minWidth: 96 } }, key.label),
                h('span', { style: { ...label, flex: 'none' } }, key.fingerprint),
                h(
                  'span',
                  { style: { ...label, flex: 1 } },
                  `${key.status}` +
                    (key.completed > 0 ? ` · 已完成 ${key.completed}` : '') +
                    (key.subscription && key.subscription.tier !== null && key.subscription.tier !== undefined ? ` · tier ${key.subscription.tier}` : '')
                ),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: () => onKeyAction('/keys/update', { id: key.id, enabled: !key.enabled }) },
                  key.enabled ? t('keyDisable') : t('keyEnable')
                ),
                h('button', { type: 'button', style: button(false), onClick: () => onKeyAction('/keys/remove', { id: key.id }) }, t('keyRemove'))
              )
            )
          ),
          (status?.keySummary?.keyIssues ?? []).map((issue) =>
            h('div', { key: issue.id, style: { ...label, marginTop: 4, color: '#c62828' } }, `${issue.label}：${issue.error}`)
          ),
          h(
            'div',
            { style: { ...row, marginTop: 10 } },
            h(
              'div',
              { style: cell(0.6) },
              h('input', { style: input, placeholder: t('keyLabel'), value: newLabel, onChange: (event) => setNewLabel(event.target.value) })
            ),
            h(
              'div',
              { style: cell(2.4) },
              h('input', {
                type: 'password',
                style: input,
                placeholder: t('keyToken'),
                value: newToken,
                onChange: (event) => setNewToken(event.target.value)
              })
            ),
            h(
              'button',
              {
                type: 'button',
                style: button(true),
                onClick: () => onKeyAction('/keys/add', { label: newLabel, token: newToken }),
                disabled: busy === 'key:/keys/add' || newToken.trim() === ''
              },
              t('keyAdd')
            ),
            h(
              'button',
              { type: 'button', style: button(false), onClick: () => onKeyAction('/keys/verify', {}), disabled: busy === 'key:/keys/verify' },
              t('keyVerify')
            )
          )
        ),

        // ---- artist string ------------------------------------------------
        h(
          'div',
          { style: section },
          h('div', { style: { fontWeight: 600 } }, t('artist')),
          // The selection lives in the config and survives a restart, but the grid
          // is 96 tiles tall and the chosen one is usually far down it. Showing the
          // current pick here — with its own thumbnail — is what makes "remembered"
          // visible instead of something the user has to scroll to confirm.
          Number(status?.artistId) >= 0 && status?.artistName
            ? h(
                'div',
                {
                  style: {
                    marginTop: 8,
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    padding: 8,
                    borderRadius: token('--dsw-radius-md', '6px'),
                    border: `1px solid ${token('--dsw-alias-accent', '#2d6cff')}`,
                    background: token('--dsw-alias-fill-l1', 'rgba(45,108,255,0.06)')
                  }
                },
                h('img', {
                  src: `${API}/artist-image?id=${Number(status.artistId)}`,
                  alt: '',
                  loading: 'lazy',
                  style: { width: 56, height: 79, objectFit: 'cover', borderRadius: 4, flex: 'none' }
                }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 13, fontWeight: 600 } }, `${t('artistCurrent')}：${status.artistName}`),
                  h('div', { style: label }, `#${Number(status.artistId)}`)
                ),
                h(
                  'button',
                  { type: 'button', style: button(false), onClick: () => onPickArtist(-1), disabled: busy === 'artist:-1' },
                  t('artistNone')
                )
              )
            : null,
          Number(status?.artistId) >= 0 && !status?.artistName
            ? h('div', { style: { ...label, marginTop: 6, color: '#c62828' } }, t('artistMissing'))
            : null,
          h(
            'div',
            { style: { ...label, marginTop: 4 } },
            // `status` is authoritative and always present, so prefer it and let the
            // `/artists` fetch fill in before the first status arrives.
            `${t('artistCount')} ${artistCount || status?.artistCount || 0}　${t('artistCurrent')}：${status?.artistName ?? '—'}`
          ),
          h(
            'div',
            { style: { ...row, marginTop: 8 } },
            h(
              'div',
              { style: cell(3) },
              h('input', {
                style: input,
                placeholder: t('artistSearch'),
                value: artistQuery,
                onChange: (event) => onArtistQuery(event.target.value)
              })
            ),
            h(
              'button',
              { type: 'button', style: button(false), onClick: () => onPickArtist(-1), disabled: busy === 'artist:-1' },
              t('artistNone')
            )
          ),
          h(
            'div',
            {
              style: {
                marginTop: 8,
                display: 'grid',
                gap: 6,
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                maxHeight: 340,
                overflowY: 'auto'
              }
            },
            artists.map((row) =>
              h(
                'button',
                {
                  key: row.id,
                  type: 'button',
                  title: row.name,
                  // React honours `ref`; the render-test stub just carries it as a
                  // prop, so the scroll effect guards for a null node.
                  ref: status?.artistId === row.id ? selectedArtistRow : undefined,
                  onClick: () => onPickArtist(row.id),
                  disabled: busy === `artist:${row.id}`,
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    padding: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderRadius: token('--dsw-radius-md', '6px'),
                    // The chosen tile has to be unmistakable at a glance: a thicker
                    // edge plus a tinted fill, not a slightly different grey.
                    border: `2px solid ${
                      status?.artistId === row.id ? token('--dsw-alias-accent', '#2d6cff') : token('--dsw-alias-border-l1', '#e6e6ea')
                    }`,
                    background:
                      status?.artistId === row.id ? token('--dsw-alias-fill-l1', 'rgba(45,108,255,0.10)') : 'transparent',
                    color: 'inherit',
                    fontSize: 12
                  }
                },
                row.hasImage
                  ? h('img', {
                      src: `${API}/artist-image?id=${row.id}`,
                      alt: '',
                      loading: 'lazy',
                      style: { width: 44, height: 62, objectFit: 'cover', borderRadius: 4, flex: 'none' }
                    })
                  : h('div', {
                      style: {
                        width: 44,
                        height: 62,
                        borderRadius: 4,
                        flex: 'none',
                        background: token('--dsw-alias-fill-l1', '#eeeeee')
                      }
                    }),
                h('span', { style: { flex: 1, lineHeight: '16px', wordBreak: 'break-word' } }, `#${row.id} ${row.name}`)
              )
            )
          )
        ),

        // ---- test render --------------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('test'))),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(4) },
            h('label', { style: label }, t('testPrompt')),
            h('textarea', {
              style: { ...input, height: 64, padding: 8, resize: 'vertical', fontFamily: 'inherit' },
              placeholder: t('testPromptPlaceholder'),
              value: prompt,
              onChange: (event) => setPrompt(event.target.value)
            })
          ),
          h(
            'div',
            { style: cell(0.4) },
            h('label', { style: label }, t('variants')),
            h('input', {
              type: 'number',
              min: 1,
              max: status?.maxImagesPerCall ?? 4,
              style: input,
              value: variants,
              onChange: (event) => setVariants(event.target.value)
            })
          ),
          h(
            'button',
            { type: 'button', style: button(true), onClick: onRender, disabled: busy === 'render' },
            busy === 'render' ? t('testing') : t('test')
          ),
          h(
            'button',
            { type: 'button', style: button(false), onClick: onProbe, disabled: busy === 'probe' },
            busy === 'probe' ? t('probing') : t('probe')
          )
        ),
        h('div', { style: { ...label, marginTop: 6 } }, t('probeHint')),
        // 官方质量词开关：默认关，需要时手动打开。
        h(
          'div',
          { style: { ...row, marginTop: 10 } },
          h(
            'button',
            {
              type: 'button',
              style: button(status?.qualityToggle === true),
              onClick: onToggleQuality,
              disabled: busy === 'quality'
            },
            status?.qualityToggle === true ? t('qualityOn') : t('qualityOff')
          ),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('qualityHint'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 10 } },
          h(
            'button',
            {
              type: 'button',
              style: button(status?.autoGenerate === true),
              onClick: onToggleAuto,
              disabled: busy === 'auto'
            },
            status?.autoGenerate === true ? t('autoOn') : t('autoOff')
          ),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('autoHint'))
        ),
        h(
          'div',
          { style: { ...row, marginTop: 10 } },
          h(
            'button',
            {
              type: 'button',
              style: button(status?.codeButtons === true),
              onClick: onToggleCodeButtons,
              disabled: busy === 'codeButtons'
            },
            status?.codeButtons === true ? t('codeButtonsOn') : t('codeButtonsOff')
          ),
          h('div', { style: { ...label, flex: '3 1 240px' } }, t('codeButtonsHint'))
        ),
        probed === null
          ? null
          : h(
              'div',
              { style: { ...card, color: probed.ok ? '#2e7d32' : '#c62828' } },
              `${probed.ok ? '✅' : '❌'} ${probed.detail ?? ''}`,
              probed.status === undefined ? '' : `　HTTP ${probed.status}`,
              probed.hint ? h('div', { style: { marginTop: 4, color: 'inherit' } }, probed.hint) : null,
              probed.subscription?.tier === undefined || probed.subscription?.tier === null
                ? ''
                : `　档位 ${probed.subscription.tier}　剩余训练步数 ${
                    (probed.subscription.fixedTrainingStepsLeft ?? 0) + (probed.subscription.purchasedTrainingStepsLeft ?? 0)
                  }`
            ),
        h('div', { style: { ...label, marginTop: 6 } }, t('inlineHint')),

        // ---- image-to-image -----------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('i2iTitle'))),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'button',
            { type: 'button', style: button(sourceName === ''), onClick: () => setPickerOpen(true) },
            sourceName === '' ? t('i2iPick') : t('i2iPickChange')
          ),
          h(
            'button',
            { type: 'button', style: button(false), onClick: onPickFile, disabled: busy === 'upload' },
            busy === 'upload' ? t('i2iUploading') : t('i2iUpload')
          ),
          h('input', {
            ref: fileInput,
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp',
            onChange: onFileChosen,
            style: { display: 'none' }
          }),
          h(
            'button',
            { type: 'button', style: button(false), onClick: loadSources, disabled: busy === 'sources' },
            t('i2iRefresh')
          ),
          sourceName === ''
            ? null
            : h(
                'button',
                { type: 'button', style: button(false), onClick: () => setSourceName('') },
                t('i2iRelease')
              )
        ),
        h('div', { style: { ...label, marginTop: 4 } }, `${t('i2iSourceDir')}: ${status?.sourceDir ?? ''}`),
        sourceName === ''
          ? h('div', { style: { ...label, marginTop: 8 } }, t('i2iNoPick'))
          : h(
              'div',
              { style: { ...row, marginTop: 8, alignItems: 'flex-start' } },
              h(
                'a',
                {
                  href: `${API}/source-file?name=${encodeURIComponent(sourceName)}`,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { display: 'inline-block' }
                },
                h('img', {
                  src: `${API}/source-file?name=${encodeURIComponent(sourceName)}`,
                  alt: sourceName,
                  style: {
                    display: 'block',
                    maxHeight: 160,
                    borderRadius: token('--dsw-radius-md', '6px'),
                    border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`
                  }
                })
              ),
              h('div', { style: { ...label, maxWidth: 260, wordBreak: 'break-all' } }, `✔ ${sourceName}`)
            ),
        // The picker is a click-to-choose grid, not a dropdown: one thumbnail is
        // selected at a time, and choosing another replaces it — the previous
        // choice is released rather than accumulated in a list.
        sourcePickerModal,
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(0.6) },
            h('label', { style: label }, 'strength'),
            h('input', {
              type: 'number',
              min: 0.01,
              max: 0.99,
              step: 0.01,
              style: input,
              value: strength,
              onChange: (event) => setStrength(event.target.value)
            })
          ),
          h(
            'div',
            { style: cell(0.6) },
            h('label', { style: label }, 'noise'),
            h('input', {
              type: 'number',
              min: 0,
              max: 0.99,
              step: 0.01,
              style: input,
              value: noise,
              onChange: (event) => setNoise(event.target.value)
            })
          ),
          h(
            'div',
            { style: cell(0.6) },
            h('label', { style: label }, t('width')),
            h('input', {
              type: 'number',
              min: 64,
              step: 64,
              style: input,
              value: i2iWidth === '' ? (status?.width ?? '') : i2iWidth,
              onChange: (event) => setI2iWidth(event.target.value)
            })
          ),
          h(
            'div',
            { style: cell(0.6) },
            h('label', { style: label }, t('height')),
            h('input', {
              type: 'number',
              min: 64,
              step: 64,
              style: input,
              value: i2iHeight === '' ? (status?.height ?? '') : i2iHeight,
              onChange: (event) => setI2iHeight(event.target.value)
            })
          ),
          h(
            'button',
            { type: 'button', style: button(true), onClick: onImg2Img, disabled: busy === 'i2i' || sourceName === '' },
            busy === 'i2i' ? t('i2iRunning') : t('i2iRun')
          )
        ),
        h('div', { style: { ...label, marginTop: 6 } }, t('i2iHint')),

        // ---- inpaint -------------------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('inpaintTitle'))),
        h('div', { style: { ...label, marginTop: 6 } }, t('inpaintHint')),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'button',
            { type: 'button', style: button(inpaintSource === ''), onClick: openInpaintPicker },
            inpaintSource === '' ? t('inpaintPick') : t('inpaintPickChange')
          ),
          inpaintSource === ''
            ? null
            : h('div', { style: { ...label } }, `${inpaintSource} · ${inpaintWidth}×${inpaintHeight}`)
        ),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(1.4) },
            h('label', { style: label }, t('inpaintBrush')),
            h('input', {
              type: 'range',
              min: 4,
              max: 120,
              step: 2,
              value: brush,
              onChange: (event) => setBrush(event.target.value),
              style: { width: '100%' }
            })
          ),
          h(
            'button',
            { type: 'button', style: button(eraseMode), onClick: () => setEraseMode((value) => !value) },
            eraseMode ? t('inpaintEraseOn') : t('inpaintErase')
          ),
          h('button', { type: 'button', style: button(false), onClick: clearMask }, t('inpaintClear')),
          h(
            'div',
            { style: cell(0.8) },
            h('label', { style: label }, t('inpaintStrength')),
            h('input', {
              type: 'number',
              min: 0,
              max: 1,
              step: 0.05,
              style: input,
              value: inpaintStrength,
              onChange: (event) => setInpaintStrength(event.target.value)
            })
          ),
          h(
            'button',
            { type: 'button', style: button(true), onClick: onInpaint, disabled: busy === 'inpaint' || inpaintSource === '' },
            busy === 'inpaint' ? t('inpaintRunning') : t('inpaintRun')
          )
        ),
        h(
          'div',
          {
            style: {
              position: 'relative',
              marginTop: 10,
              width: '100%',
              maxWidth: 420,
              borderRadius: token('--dsw-radius-md', '6px'),
              overflow: 'hidden',
              border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
              background: 'repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
            }
          },
          h('canvas', { ref: baseCanvas, style: { display: 'block', width: '100%', height: 'auto' } }),
          h('canvas', {
            ref: maskCanvas,
            onPointerDown: onMaskDown,
            onPointerMove: onMaskMove,
            onPointerUp: onMaskUp,
            onPointerLeave: onMaskUp,
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              opacity: 0.45,
              cursor: 'crosshair',
              touchAction: 'none'
            }
          })
        ),

        // Gallery picker: the inpaint base is a finished render, so the grid is
        // the output gallery rather than the source directory.
        galleryPickerModal,

        // ---- director tools ------------------------------------------------
        h('div', { style: section }, h('div', { style: { fontWeight: 600 } }, t('directorTitle'))),
        h('div', { style: { ...label, marginTop: 6 } }, t('directorHint')),
        h(
          'div',
          { style: { ...row, marginTop: 8 } },
          h(
            'div',
            { style: cell(1.2) },
            h('label', { style: label }, t('directorTool')),
            h(
              'select',
              {
                style: input,
                value: directorType,
                onChange: (event) => setDirectorType(event.target.value)
              },
              [
                ['lineart', t('directorLineart')],
                ['sketch', t('directorSketch')],
                ['colorize', t('directorColorize')],
                ['emotion', t('directorEmotionTool')],
                ['declutter', t('directorDeclutter')]
              ].map(([value, text]) => h('option', { key: value, value }, text))
            )
          ),
          directorType === 'emotion'
            ? h(
                'div',
                { style: cell(1) },
                h('label', { style: label }, t('directorEmotion')),
                h('input', {
                  type: 'text',
                  style: input,
                  placeholder: 'happy / sad / angry …',
                  value: directorEmotion,
                  onChange: (event) => setDirectorEmotion(event.target.value)
                })
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              style: button(true),
              onClick: onDirector,
              disabled: busy === 'director' || inpaintSource === ''
            },
            busy === 'director' ? t('directorRunning') : t('directorRun')
          )
        ),
        inpaintSource === ''
          ? h('div', { style: { ...label, marginTop: 4 } }, t('i2iNoPick'))
          : h('div', { style: { ...label, marginTop: 4 } }, `${t('directorUsing')}: ${inpaintSource}`),

        // ---- gallery ------------------------------------------------------
        h(
          'div',
          { style: section },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontWeight: 600 } }, t('gallery')),
            h('div', { style: label }, status?.outputDir ?? ''),
            h(
              'button',
              { type: 'button', style: button(false), onClick: refresh },
              t('refresh')
            )
          )
        ),
        shots.length === 0
          ? h('div', { style: { ...label, marginTop: 10 } }, t('galleryEmpty'))
          : h(
              'div',
              {
                style: {
                  marginTop: 10,
                  display: 'grid',
                  gap: 10,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))'
                }
              },
              shots.map((file) =>
                h(
                  'a',
                  {
                    key: file.name,
                    href: `${API}/file?name=${encodeURIComponent(file.name)}`,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: {
                      display: 'block',
                      borderRadius: token('--dsw-radius-md', '6px'),
                      overflow: 'hidden',
                      border: `1px solid ${token('--dsw-alias-border-l1', '#e6e6ea')}`,
                      background:
                        'repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
                    }
                  },
                  h('img', {
                    src: `${API}/file?name=${encodeURIComponent(file.name)}`,
                    alt: file.name,
                    loading: 'lazy',
                    // Claimed by the right-click menu, so a thumbnail in the panel
                    // can be copied or saved without opening it first.
                    [IMG_ATTR]: '1',
                    'data-nai-name': file.name,
                    'data-nai-kind': 'gallery',
                    style: { display: 'block', width: '100%', height: 'auto' }
                  })
                )
              )
            )
      )
    }

    // ---------------------------------------------------------------- code blocks --
    // A prompt sitting in a code block should be one click from an image. There
    // is no slot that renders per code block, so — following the same approach
    // the workspace's own `bundle-chat-delete` uses where no seat exists — this
    // walks the transcript with a MutationObserver and injects a button beside
    // every block that reads like a NovelAI prompt.
    //
    // Two consequences are handled explicitly:
    //   * a transcript re-render discards injected nodes, so results are cached
    //     by prompt hash and restored on the next scan;
    //   * injected nodes must not be mistaken for content, so they carry a marker
    //     and the scanner skips its own output.

    /** Marks a code card this half already decorated. */
    const DONE_ATTR = 'data-nai-imagegen-block'
    /** Marks nodes this half injected, so the scanner skips its own output. */
    const OURS_ATTR = 'data-nai-imagegen-ours'
    /** Generated results, keyed by prompt hash, so a re-render can restore them. */
    const generated = new Map()
    /** Prompt hashes already auto-rendered, so a re-render cannot spend quota twice. */
    const autoDone = new Set()
    /**
     * How many auto-renders may fire in one session.
     *
     * Auto-render spends quota without being asked, so it gets a ceiling: a
     * transcript full of prompt blocks must not turn into a bill. Past the cap
     * the buttons stay, they just need clicking.
     */
    const AUTO_RENDER_MAX = 12
    /**
     * Auto-renders allowed for the pass currently running.
     *
     * A normal pass allows everything eligible. The forced pass that happens when
     * the toggle turns on allows exactly one — and scans newest-first, so the one
     * the user is looking at is the one that fires rather than the oldest block
     * in the transcript.
     */
    let autoAllowance = Number.POSITIVE_INFINITY
    /**
     * Whether prompt blocks render on their own. Driven by the panel's toggle,
     * which writes through this flag rather than recreating the observer.
     */
    let autoRender = false
    /**
     * The watcher's scan, published so the panel can force a pass.
     *
     * The observer only re-scans when the DOM changes. A transcript sitting still
     * — which is exactly the case when the user has just found a prompt and
     * flipped auto-render on — would otherwise keep showing a button with
     * nothing rendered behind it.
     */
    let rescanBlocks = null

    /**
     * FNV-1a over the prompt text. Stable across renders, unlike an index.
     * @param text - the prompt.
     * @returns a hexadecimal digest.
     */
    function hashOf(text) {
      let hash = 0x811c9dc5
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16)
    }

    /**
     * Decide whether a code block is a NovelAI prompt rather than code.
     *
     * A fence tagged `nai` / `prompt` / `novelai` always qualifies, which gives an
     * explicit opt-in. Otherwise the text has to look like a tag list and not like
     * a program: source-shaped lines disqualify it outright, and a couple of
     * Danbooru signals (or NAI weight syntax) have to be present.
     *
     * @param text - the block's text.
     * @param language - the fence language, if any.
     * @returns true when the button belongs there.
     */
    function looksLikePrompt(text, language) {
      if (/^(nai|novelai|prompt)$/i.test(language ?? '')) return true
      const trimmed = String(text ?? '').trim()
      // A 「文生图」 `<image>` block is always a prompt. Checked before the length
      // bound because a full block with several characters runs long, and its
      // structure is unmistakable however its tags happen to read.
      //
      // The tag has to open a line, matching the host's own test. A prompt that
      // merely mentions `<image>` in passing must not get a button whose click
      // then fails, because the host refuses an unreadable block rather than
      // rendering its labels as picture content.
      if (/^[ \t]*<image\b[^>]*>/im.test(trimmed) || /image\s*#{2,}/i.test(trimmed)) return true
      if (trimmed.length < 24 || trimmed.length > 12000) return false
      if (
        /(^|\n)\s*(import |export |from '|function |const |let |var |class |def |#include|using |<\?php|SELECT |INSERT |UPDATE |CREATE TABLE|npm |pnpm |git |\$ |PS>|curl |\{\s*")/m.test(
          trimmed
        )
      ) {
        return false
      }
      const signals = [
        /\b[12]girls?\b/i,
        /\b[12]boys?\b/i,
        /\bsolo\b/i,
        /\blooking at viewer\b/i,
        /\bmasterpiece\b|\bbest quality\b|\babsurdres\b/i,
        /::/,
        /\bchar[0-9]\s*:/i,
        /\btransparent background\b/i,
        /\bdefault costume\b|\bofficial default outfit\b/i
      ]
      let hits = 0
      for (const pattern of signals) if (pattern.test(trimmed)) hits += 1
      if ((trimmed.match(/,/g) ?? []).length >= 6) hits += 1
      return hits >= 2
    }

    /**
     * Render generated files under a code block.
     * @param slot - the container to fill.
     * @param files - the records the Host returned.
     */
    function showFiles(slot, files) {
      slot.replaceChildren()
      for (const file of files) {
        const name = file.name ?? String(file.file ?? '').split(/[\\/]/).pop()
        if (!name) continue
        const figure = document.createElement('figure')
        figure.style.cssText = 'margin:8px 0 0;display:flex;flex-direction:column;gap:4px'
        const image = document.createElement('img')
        image.src = `${API}/file?name=${encodeURIComponent(name)}`
        image.alt = 'NovelAI generated image'
        image.loading = 'lazy'
        // Tagged so the right-click menu offers copy and save for exactly this.
        markImage(image, { name, path: typeof file.file === 'string' ? file.file : '', kind: 'render' })
        image.style.cssText =
          'max-width:100%;height:auto;border-radius:var(--dsw-radius-md,6px);' +
          'background:repeating-conic-gradient(#e9e9ee 0% 25%, #f7f7fa 0% 50%) 50% / 16px 16px'
        const caption = document.createElement('figcaption')
        caption.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
        caption.textContent = [
          file.model ?? '',
          file.size ?? '',
          file.seed === null || file.seed === undefined ? '' : `seed ${file.seed}`
        ]
          .filter(Boolean)
          .join(' · ')
        figure.append(image, caption)
        slot.append(figure)
      }
    }

    /** What was injected per host, so a later pass can fire an existing button. */
    const decorated = new WeakMap()

    /**
     * Fire an auto-render for one block, if the toggle and the budget allow.
     *
     * Both the fresh-decorate path and the re-visited path go through here, so
     * the bounds are stated once instead of being duplicated.
     *
     * @param button - the block's button.
     * @param key - the prompt's hash.
     * @returns true when a render was started.
     */
    function autoFire(button, key) {
      if (!autoRender) return false
      if (generated.has(key)) return false
      if (autoDone.has(key)) return false
      if (autoAllowance <= 0) return false
      if (autoDone.size >= AUTO_RENDER_MAX) return false
      if (typeof button.click !== 'function') return false
      autoAllowance -= 1
      autoDone.add(key)
      button.click()
      return true
    }

    // ------------------------------------------------------------ image menu --
    // Right-click on a generated image offers the three things anyone actually
    // wants from one: the pixels on the clipboard, the path, or a save dialog.
    //
    // Only this plugin's own images are claimed. A document-wide `contextmenu`
    // listener that swallowed every `<img>` in the app would be indefensible, so
    // each image this half creates carries a marker and anything without it is
    // left alone.

    /** Marks an image as one of ours, so the menu only claims its own. */
    const IMG_ATTR = 'data-nai-imagegen-image'
    /** The floating menu, when open. */
    let imageMenu = null

    /**
     * Whether an `<img>` in the transcript is a render rather than part of the UI.
     *
     * **Deliberately not decided by the URL.** The host proxies the bytes under an
     * opaque `/attachments/v1/objects/…` address, so the output directory never
     * appears in `src` — matching on the path was why a right-click did nothing on
     * exactly the images the user right-clicks, while the gallery's own copies (which
     * this half marked when it built them) worked.
     *
     * The **rendered size** is what actually separates a render from chrome: an
     * avatar, a chevron or an icon is never 256 pixels on a side. The path and alt
     * checks stay as secondary signals for hosts that do keep the path.
     * @param image - the `<img>` element.
     * @returns true when it is one of ours.
     */
    function isOurOutput(image) {
      const width = Number(image?.naturalWidth ?? image?.width ?? 0)
      const height = Number(image?.naturalHeight ?? image?.height ?? 0)
      if (width >= 256 && height >= 256) return true
      const src = String(image?.getAttribute?.('src') ?? image?.src ?? '')
      const alt = String(image?.getAttribute?.('alt') ?? '')
      return /_out[\\/]nai[\\/]|[\\/]nai-imagegen[\\/]/i.test(src) || alt === GENERATED_ALT
    }

    /** The file name an `<img>` is serving, when its address carries one. */
    function nameFromSrc(image) {
      const src = String(image?.getAttribute?.('src') ?? image?.src ?? '')
      const last = src.split(/[?#]/)[0].split(/[\\/]/).pop() ?? ''
      return /\.(png|jpe?g|webp)$/i.test(last) ? decodeURIComponent(last) : ''
    }

    /**
     * Tag an image so the right-click menu claims it.
     * @param image - the `<img>` element.
     * @param info - `{ name, path, kind }`.
     * @returns the same element, for chaining.
     */
    function markImage(image, info = {}) {
      image.setAttribute(IMG_ATTR, '1')
      if (typeof info.name === 'string' && info.name !== '') image.setAttribute('data-nai-name', info.name)
      if (typeof info.path === 'string' && info.path !== '') image.setAttribute('data-nai-path', info.path)
      if (typeof info.kind === 'string' && info.kind !== '') image.setAttribute('data-nai-kind', info.kind)
      return image
    }

    /** Close the floating menu, if one is open. */
    function closeImageMenu() {
      if (imageMenu !== null) {
        imageMenu.remove()
        imageMenu = null
      }
    }

    /**
     * Re-encode an image as PNG, which is the only format the clipboard accepts.
     * @param blob - the source blob.
     * @returns a PNG blob.
     */
    async function toPng(blob) {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      if (typeof bitmap.close === 'function') bitmap.close()
      return await new Promise((resolve, reject) => {
        canvas.toBlob((out) => (out === null ? reject(new Error('转成 PNG 失败')) : resolve(out)), 'image/png')
      })
    }

    /**
     * Put an image on the clipboard.
     * @param image - the `<img>` element.
     */
    async function copyImageToClipboard(image) {
      if (navigator.clipboard === undefined || typeof ClipboardItem === 'undefined') {
        throw new Error('这个环境不支持把图片写进剪贴板')
      }
      const response = await fetch(image.src)
      if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`)
      const blob = await response.blob()
      // Generated files are already PNG, so the canvas round trip is only for
      // anything else that ends up here.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob.type === 'image/png' ? blob : await toPng(blob) })])
    }

    /**
     * Put text on the clipboard.
     * @param value - the text.
     */
    async function copyTextToClipboard(value) {
      if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('这个环境不支持写剪贴板')
      }
      await navigator.clipboard.writeText(value)
    }

    /**
     * Open the menu for one image at a point.
     * @param image - the `<img>` element.
     * @param x - viewport x.
     * @param y - viewport y.
     * @param t - the bound dictionary.
     */
    function openImageMenu(image, x, y, t) {
      closeImageMenu()
      const name = image.getAttribute('data-nai-name') ?? ''
      const path = image.getAttribute('data-nai-path') ?? ''
      const status = document.createElement('div')
      status.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary,#888);padding:2px 8px;min-height:14px'

      /** Run one action, reporting failure in the menu rather than nowhere. */
      const run = async (label, action) => {
        status.textContent = `${label}…`
        try {
          await action()
          status.textContent = `${label} ✓`
          setTimeout(closeImageMenu, 700)
        } catch (error) {
          status.textContent = `${label} 失败：${error.message}`
        }
      }

      const item = (label, action) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.textContent = label
        row.style.cssText =
          'display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;cursor:pointer;' +
          'border:0;background:transparent;color:inherit;border-radius:var(--dsw-radius-sm,4px)'
        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--dsw-alias-fill-l1,rgba(127,127,127,0.12))'
        })
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent'
        })
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          run(label, action)
        })
        return row
      }

      const menu = document.createElement('div')
      menu.setAttribute(IMG_ATTR, '1')
      menu.style.cssText =
        'position:fixed;z-index:2147483000;min-width:172px;padding:4px;' +
        'border-radius:var(--dsw-radius-md,6px);border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
        'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,inherit);' +
        'box-shadow:0 6px 24px rgba(0,0,0,0.18);font-size:12px'
      menu.append(
        item(t('copyImage'), () => copyImageToClipboard(image)),
        ...(name === '' ? [] : [item(t('copyName'), () => copyTextToClipboard(name))]),
        ...(path === '' ? [] : [item(t('copyPath'), () => copyTextToClipboard(path))]),
        ...(name === ''
          ? []
          : [
              item(t('saveAs'), () => {
                const anchor = document.createElement('a')
                anchor.href = image.src
                anchor.download = name
                document.body.append(anchor)
                anchor.click()
                anchor.remove()
              })
            ]),
        status
      )
      document.body.append(menu)
      // Keep the menu on screen when the click lands near an edge.
      const box = menu.getBoundingClientRect()
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`
      imageMenu = menu
    }

    /**
     * Watch for right-clicks on this plugin's images.
     * @param t - the bound dictionary.
     * @returns a disposer.
     */
    function installImageMenu(t) {
      if (typeof document === 'undefined') return () => {}
      const onContextMenu = (event) => {
        const target = event.target
        if (target === null || typeof target.closest !== 'function') return
        let image = target.closest(`img[${IMG_ATTR}]`)
        if (image === null) {
          // An image the transcript rendered from `![描述](路径)` — which is how every
          // render is delivered — was never seen by this half, so nothing marked it
          // and a right-click on it did nothing. Adopting it here is what makes
          // "the generated image can be copied" true for the image actually being
          // right-clicked, rather than only for the gallery's copies.
          const candidate = target.closest('img')
          if (candidate !== null && isOurOutput(candidate)) {
            // The name travels too, so 「复制文件名」 and 「另存为」 still mean
            // something for an image this half did not build.
            markImage(candidate, { kind: 'transcript', name: nameFromSrc(candidate) })
            image = candidate
          }
        }
        if (image === null) return
        event.preventDefault()
        event.stopPropagation()
        openImageMenu(image, event.clientX, event.clientY, t)
      }
      const onDismiss = () => closeImageMenu()
      const onKey = (event) => {
        if (event.key === 'Escape') closeImageMenu()
      }
      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('click', onDismiss, true)
      document.addEventListener('scroll', onDismiss, true)
      document.addEventListener('keydown', onKey, true)
      return () => {
        closeImageMenu()
        document.removeEventListener('contextmenu', onContextMenu, true)
        document.removeEventListener('click', onDismiss, true)
        document.removeEventListener('scroll', onDismiss, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }

    /**
     * Add the button and result slot to one code block, if it qualifies.
     * @param pre - the `<pre>` element.
     * @param t - the bound dictionary.
     */
    function decorate(pre, t) {
      if (pre.closest(`[${OURS_ATTR}]`) !== null) return
      const code = pre.querySelector('code') ?? pre
      const text = String(code.textContent ?? '')
      const language = (/language-([\w-]+)/.exec(code.className ?? '') ?? [])[1]
      if (!looksLikePrompt(text, language)) return
      const host = pre.parentElement ?? pre
      const key = hashOf(text.trim())

      // A block that already carries a button still has to be reconsidered, for two
      // separate reasons:
      //
      //   * the toggle may have just been turned on, and the button already sitting
      //     there is the one that should fire;
      //   * **the text may have grown since.** The transcript mounts a `<pre>` and
      //     fills it afterwards, and a streaming reply grows one a few characters at
      //     a time. A block decorated while it was still arriving keeps its
      //     truncated text forever, so clicking it renders — or fails on — a
      //     fragment. Re-decorating a block whose body changed is what fixes that.
      const previous = decorated.get(host)
      if (previous !== undefined) {
        if (previous.text === text) {
          autoFire(previous.button, previous.key)
          return
        }
        for (const node of previous.injected) {
          if (node !== null && typeof node.remove === 'function') node.remove()
        }
        decorated.delete(host)
      } else if (host.getAttribute(DONE_ATTR) === '1') {
        // Marked, but nothing recorded: leave it alone rather than stacking a
        // second button onto markup this half did not create.
        return
      }
      host.setAttribute(DONE_ATTR, '1')

      const bar = document.createElement('div')
      bar.setAttribute(OURS_ATTR, '1')
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px'

      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = t('blockButton')
      button.style.cssText =
        'height:24px;padding:0 10px;font-size:12px;cursor:pointer;border-radius:var(--dsw-radius-sm,4px);' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:transparent;color:inherit'
      const status = document.createElement('span')
      status.style.cssText = 'color:var(--dsw-alias-label-tertiary,#888)'
      const slot = document.createElement('div')
      slot.setAttribute(OURS_ATTR, '1')

      button.addEventListener('click', async () => {
        button.disabled = true
        button.textContent = t('blockWorking')
        status.textContent = ''
        try {
          const body = await api('/generate', { method: 'POST', body: JSON.stringify({ prompt: text.trim() }) })
          generated.set(key, body.files ?? [])
          showFiles(slot, body.files ?? [])
          status.textContent = t('blockDone')
        } catch (error) {
          slot.replaceChildren()
          const failure = document.createElement('div')
          failure.style.cssText = 'margin-top:6px;font-size:12px;color:#c62828;white-space:pre-wrap'
          failure.textContent = `${t('blockFailed')}：${error.message}`
          slot.append(failure)
        } finally {
          button.disabled = false
          button.textContent = t('blockButton')
        }
      })

      bar.append(button, status)
      host.append(bar, slot)
      // `text` is the snapshot this decoration was built from: a later scan
      // compares against it and redoes the block if the transcript has filled in
      // more since. `injected` is what to remove when that happens.
      decorated.set(host, { button, key, text, injected: [bar, slot] })

      const cached = generated.get(key)
      if (cached !== undefined) {
        showFiles(slot, cached)
        status.textContent = t('blockDone')
      } else {
        // Once per distinct prompt, ever: a transcript re-render must not re-spend.
        autoFire(button, key)
      }
    }

    /**
     * Watch the transcript and keep every qualifying code block decorated.
     * @param t - the bound dictionary.
     * @returns a disposer that stops the observer.
     */
    function installCodeButtons(t) {
      // A browser always has both; the guard keeps activation from throwing if
      // this bundle is ever evaluated where no DOM exists.
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      /**
       * Decorate everything currently in the document.
       * @param options - `{ autoLastOnly: true }` allows a single auto-render,
       *   for the newest block, which is what the toggle-on pass wants.
       */
      const scan = (options = {}) => {
        const nodes = Array.from(document.querySelectorAll('pre'))
        // Newest first, so a single allowance lands on what the user is looking at.
        if (options.autoLastOnly === true) nodes.reverse()
        autoAllowance = options.autoLastOnly === true ? 1 : Number.POSITIVE_INFINITY
        for (const pre of nodes) {
          try {
            decorate(pre, t)
          } catch {
            // One malformed block must not abort the rest of the scan.
          }
        }
        autoAllowance = Number.POSITIVE_INFINITY
      }
      scan()
      rescanBlocks = scan
      let queued = false
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          scan()
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        rescanBlocks = null
        observer.disconnect()
        // Turning the feature off must also take the buttons away, not just stop
        // future scans — otherwise the transcript keeps a row of dead buttons.
        for (const [host, record] of decorated) {
          for (const node of record.injected) {
            if (node !== null && typeof node.remove === 'function') node.remove()
          }
          if (typeof host.removeAttribute === 'function') host.removeAttribute(DONE_ATTR)
        }
        decorated.clear()
      }
    }

    /**
     * The panel page needs the dictionary namespace bound to it as `t`, and the
     * packager supplies locale-bound helpers through the registration's `locale`
     * field; `props.t` is that binding when present, so the fallbacks above only
     * matter before the dictionary lands.
     *
     * The code-block buttons are plain DOM rather than a slot occupant, so they
     * are installed here and torn down with the same effect scope.
     * @param ctx - the client root context.
     */
    // --------------------------------------------------------- floating studio --
    // A draggable window for the per-mode settings. The sidebar panel is one long
    // column, and the question "what will 漫画 use" wants the two modes side by
    // side rather than buried in a form.
    //
    // Plain DOM rather than React: it lives outside the slot tree, so it stays open
    // while the transcript scrolls — the same approach as the image menu.

    /** Marks nodes this half injected, so nothing else claims them. */
    const STUDIO_MARK = 'data-nai-imagegen-studio'
    /** The alt text the render tool puts on every image it returns. */
    const GENERATED_ALT = '生成图片'
    /** The open window, or null. */
    let studio = null

    /** The knobs, mirroring the host's `MODE_FIELDS`. */
    const STUDIO_FIELDS = [
      { key: 'width', label: '宽', kind: 'number', min: 64, max: 2048, step: 64 },
      { key: 'height', label: '高', kind: 'number', min: 64, max: 2048, step: 64 },
      { key: 'steps', label: '步数', kind: 'number', min: 1, max: 50, step: 1 },
      { key: 'scale', label: '引导', kind: 'number', min: 0, max: 20, step: 0.1 },
      // 手填数字，上限标 4（官方 `none`），并在下面给出档位对照。
      // 用数字框而非下拉：想填几填几，NovelAI 以后加档位也不用改代码。
      { key: 'ucPreset', label: 'UC 预设', kind: 'number', min: 0, max: 4, step: 1 },
      { key: 'maxImagesPerCall', label: '每次上限', kind: 'number', min: 1, max: 16, step: 1 },
      { key: 'model', label: '模型', kind: 'text' },
      { key: 'sampler', label: '采样器', kind: 'text' },
      // 官方质量词开关，按模式记。悬浮窗里用 0/1 数字表示布尔，
      // 与既有字段的渲染方式一致（它只支持 number/text 两种 kind）。
      { key: 'qualityToggle', label: '官方质量词', kind: 'number', min: 0, max: 1, step: 1 },
      // 头部插入：按模式记，所以漫画页和单图可以各用各的前导标签。
      { key: 'header', label: '头部插入', kind: 'text' }
    ]

    /** The two modes. */
    const STUDIO_MODES = [
      { key: 'illustration', label: '🖼 出图' },
      { key: 'comic', label: '📖 漫画' }
    ]

    /** The override fields, mirroring the host's `MODE_FIELDS`. */
    const MODE_KEYS = {
      artistId: 1,
      width: 1,
      height: 1,
      steps: 1,
      scale: 1,
      ucPreset: 1,
      maxImagesPerCall: 1,
      model: 1,
      sampler: 1,
      negativePrompt: 1,
      qualityToggle: 1,
      header: 1,
      recipe: 1
    }

    /** Shared input styling. */
    const STUDIO_INPUT =
      'height:26px;padding:0 6px;font-size:12px;box-sizing:border-box;' +
      'border-radius:var(--dsw-radius-sm,4px);border:1px solid var(--dsw-alias-border-l1,#d0d0d5);' +
      'background:transparent;color:inherit'

    /**
     * Build one labelled row.
     * @param label - the visible label.
     * @param input - the control.
     * @param options - `{ changed }`; a changed row is marked so it is obvious which
     *   settings are actually overriding the shared default rather than sitting at it.
     * @returns the row element.
     */
    function studioRow(label, input, options = {}) {
      const row = document.createElement('label')
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-size:12px'
      const name = document.createElement('span')
      name.textContent = options.changed === true ? `● ${label}` : label
      name.style.cssText =
        'flex:none;width:64px;line-height:26px;' +
        (options.changed === true
          ? 'color:var(--dsw-alias-accent,#2d6cff);font-weight:600'
          : 'color:var(--dsw-alias-label-secondary,#666)')
      if (options.changed === true && typeof options.changedTitle === 'string') name.title = options.changedTitle
      input.style.cssText = `${STUDIO_INPUT};flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111)`
      row.append(name, input)
      return row
    }

    /**
     * Open the studio, or repaint an already-open one.
     * @param t - the bound dictionary.
     */
    async function openStudio(t) {
      if (studio !== null) {
        studio.root.style.display = 'flex'
        studio.paint()
        return
      }
      const status = await api('/status')
      const artists = await api('/artists?limit=1000').catch(() => ({ artists: [] }))
      let active = String(status.mode ?? '') === 'comic' ? 'comic' : 'illustration'
      /** Working copies, so nothing is written until Save. */
      const draft = {}
      for (const mode of STUDIO_MODES) {
        draft[mode.key] = { ...((status.modeSettings ?? []).find((row) => row.mode === mode.key) ?? {}) }
      }

      const root = document.createElement('div')
      root.setAttribute(STUDIO_MARK, 'window')
      root.style.cssText =
        'position:fixed;z-index:2147483000;right:18px;bottom:70px;width:344px;max-height:76vh;' +
        'display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg,10px);' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:var(--dsw-alias-bg-base,#fff);' +
        'color:var(--dsw-alias-label-primary,inherit);box-shadow:0 12px 40px rgba(0,0,0,0.22);font-size:12px'

      const header = document.createElement('div')
      header.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;flex:none;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1,#e6e6ea)'
      const title = document.createElement('span')
      title.textContent = t('studioTitle')
      title.style.cssText = 'flex:1;font-weight:600'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '✕'
      close.style.cssText = 'border:0;background:transparent;cursor:pointer;color:inherit;font-size:14px;padding:0 4px'
      close.addEventListener('click', () => {
        root.remove()
        studio = null
      })
      header.append(title, close)

      const tabs = document.createElement('div')
      tabs.style.cssText = 'display:flex;gap:6px;padding:8px 10px 4px;flex:none'
      const body = document.createElement('div')
      body.style.cssText = 'padding:4px 10px 10px;overflow-y:auto;display:flex;flex-direction:column;gap:7px'
      const actions = document.createElement('div')
      actions.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:8px 10px;flex:none;border-top:1px solid var(--dsw-alias-border-l1,#e6e6ea)'

      /**
       * One line describing the style in force.
       * @param current - the working settings.
       * @returns the text.
       */
      /**
       * Whether one of a mode's fields differs from the shared default.
       *
       * Compared by type: the inputs hand back numbers for numeric fields and
       * strings otherwise, while `/status` reports the resolved value, so a strict
       * `!==` would flag every row the moment a type drifted. An empty value means
       * "inherit", which is not a difference.
       * @param field - the field descriptor.
       * @param current - the mode's working settings.
       * @returns true when it is an override rather than the default.
       */
      const differsFrom = (field, current) => {
        const mine = current[field.key]
        const base = status[field.key]
        if (mine === undefined || mine === null || mine === '') return false
        if (base === undefined || base === null) return true
        if (field.kind === 'number') return Number(mine) !== Number(base)
        return String(mine) !== String(base)
      }

      const artistLine = (current) => {
        const name = current.artistName
        const label = `${t('artistCurrent')}：${name ?? (Number(current.artistId) >= 0 ? `#${Number(current.artistId)}` : t('artistNone'))}`
        return Number(current.artistChars ?? 0) > 0 ? `${label}（+${current.artistChars} 字符）` : label
      }

      /** Rebuild the body for the active mode. */
      const paint = () => {
        for (const node of tabs.children) {
          const on = node.dataset.mode === active
          node.style.background = on ? 'var(--dsw-alias-fill-l2,rgba(127,127,127,0.20))' : 'transparent'
          node.style.fontWeight = on ? '600' : '400'
        }
        body.replaceChildren()
        const current = draft[active]

        // The artist string leads: it is the setting most likely to differ between
        // a single illustration and a comic page, and the one that was previously
        // shared by accident.
        const picker = document.createElement('select')
        const none = document.createElement('option')
        none.value = '-1'
        none.textContent = t('artistNone')
        picker.append(none)
        for (const row of artists.artists ?? []) {
          const option = document.createElement('option')
          option.value = String(row.id)
          option.textContent = `#${row.id} ${row.name}`
          picker.append(option)
        }
        picker.value = String(Number(current.artistId ?? -1))
        const summary = document.createElement('div')
        summary.style.cssText = 'font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888);white-space:pre-wrap'
        picker.addEventListener('change', () => {
          current.artistId = Number(picker.value)
          current.artistName = (artists.artists ?? []).find((row) => row.id === current.artistId)?.name ?? null
          summary.textContent = artistLine(current)
        })
        const link = document.createElement('a')
        link.target = '_blank'
        link.rel = 'noreferrer'
        link.style.cssText = 'flex:none;width:26px;height:26px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-fill-l1,#eee)'
        if (Number(current.artistId) >= 0) {
          link.href = `${API}/artist-image?id=${Number(current.artistId)}`
          const thumb = document.createElement('img')
          thumb.src = link.href
          thumb.alt = ''
          thumb.loading = 'lazy'
          thumb.style.cssText = 'width:100%;height:100%;object-fit:cover'
          link.append(thumb)
        }
        const pickerRow = studioRow(t('studioArtist'), picker)
        pickerRow.append(link)
        body.append(pickerRow)

        // The comic console's own switches. Only the comic mode has panels to pace
        // and a page to margin, so the illustration side does not show them.
        if (active === 'comic') {
          const groups = (status.modeSettings ?? []).find((row) => row.mode === 'comic')?.recipeGroups ?? []
          const recipe = current.recipe ?? {}
          const heading = document.createElement('div')
          heading.textContent = t('studioRecipe')
          heading.style.cssText = 'font-size:11px;font-weight:600;margin-top:2px;color:var(--dsw-alias-label-secondary,#666)'
          body.append(heading)
          for (const group of groups) {
            const select = document.createElement('select')
            for (const option of group.options) {
              const entry = document.createElement('option')
              entry.value = option.key
              entry.textContent = option.label
              select.append(entry)
            }
            select.value = recipe[group.key] ?? group.default
            const changed = String(select.value) !== String(group.default)
            select.addEventListener('change', () => {
              current.recipe = { ...(current.recipe ?? {}), [group.key]: select.value }
            })
            body.append(studioRow(group.label, select, { changed }))
            // A group whose effect is not obvious — 页数 never reaches the image API,
            // 对白语言 only letters text that already exists — says so rather than
            // reading as a switch that does nothing.
            if (typeof group.note === 'string' && group.note !== '') {
              const note = document.createElement('div')
              note.textContent = group.note
              note.style.cssText = 'font-size:10px;line-height:13px;padding-left:72px;margin-top:-4px;color:var(--dsw-alias-label-tertiary,#888)'
              body.append(note)
            }
          }
        }

        for (const field of STUDIO_FIELDS) {
          const input = document.createElement('input')
          input.type = field.kind === 'number' ? 'number' : 'text'
          if (field.min !== undefined) input.min = String(field.min)
          if (field.max !== undefined) input.max = String(field.max)
          if (field.step !== undefined) input.step = String(field.step)
          input.value = current[field.key] === undefined || current[field.key] === null ? '' : String(current[field.key])
          input.addEventListener('input', () => {
            current[field.key] = field.kind === 'number' ? Number(input.value) : input.value
          })
          // Marked when it differs from the shared default, so "which of these is
          // actually doing something" is answerable at a glance. A mode sitting
          // entirely at the defaults renders exactly like the other one, which is
          // what made a save look like it had done nothing.
          body.append(studioRow(field.label, input, { changed: differsFrom(field, current) }))
        }

        const negative = document.createElement('textarea')
        negative.rows = 3
        negative.style.cssText = `${STUDIO_INPUT};height:auto;padding:6px;resize:vertical;width:100%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111)`
        negative.value = current.negativePrompt ?? ''
        negative.addEventListener('input', () => {
          current.negativePrompt = negative.value
        })
        body.append(studioRow(t('studioNegative'), negative, { changed: String(current.negativePrompt ?? '') !== String(status.negativePrompt ?? '') }))

        summary.textContent = artistLine(current)
        body.append(summary)
        const note = document.createElement('div')
        note.style.cssText = 'font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#888)'
        note.textContent = t('studioHint')
        body.append(note)
      }

      for (const mode of STUDIO_MODES) {
        const tab = document.createElement('button')
        tab.type = 'button'
        tab.dataset.mode = mode.key
        tab.textContent = mode.label
        tab.style.cssText = `${STUDIO_INPUT};flex:1;cursor:pointer`
        tab.addEventListener('click', () => {
          active = mode.key
          paint()
        })
        tabs.append(tab)
      }

      const statusLine = document.createElement('span')
      statusLine.style.cssText = 'flex:1;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)'
      const save = document.createElement('button')
      save.type = 'button'
      save.textContent = t('studioSave')
      save.style.cssText =
        'height:28px;padding:0 14px;font-size:12px;cursor:pointer;font-weight:600;' +
        'border-radius:var(--dsw-radius-sm,4px);border:1px solid var(--dsw-alias-accent,#2d6cff);' +
        'background:transparent;color:inherit'
      save.addEventListener('click', async () => {
        statusLine.textContent = `${t('studioSave')}…`
        try {
          const modes = {}
          for (const mode of STUDIO_MODES) {
            const row = {}
            for (const [key, value] of Object.entries(draft[mode.key])) {
              // Only override fields travel; everything else is derived and must not
              // be written back as if it were a setting.
              if (!Object.prototype.hasOwnProperty.call(MODE_KEYS, key)) continue
              if (value === undefined || value === null) continue
              if (typeof value === 'number' && !Number.isFinite(value)) continue
              row[key] = value
            }
            modes[mode.key] = row
          }
          await api('/config', { method: 'POST', body: JSON.stringify({ modes }) })
          const fresh = await api('/status')
          for (const mode of STUDIO_MODES) {
            draft[mode.key] = { ...((fresh.modeSettings ?? []).find((row) => row.mode === mode.key) ?? {}) }
          }
          statusLine.textContent = `${t('studioSaved')} ✓`
          paint()
        } catch (error) {
          statusLine.textContent = `${t('studioFailed')}：${error.message}`
        }
      })
      actions.append(save, statusLine)

      // Drag by the header, so the window can be moved off whatever it covers.
      let dragging = null
      header.addEventListener('pointerdown', (event) => {
        dragging = { x: event.clientX, y: event.clientY, left: root.offsetLeft, top: root.offsetTop }
      })
      header.addEventListener('pointermove', (event) => {
        if (dragging === null) return
        root.style.left = `${Math.max(4, Math.min(window.innerWidth - 80, dragging.left + (event.clientX - dragging.x)))}px`
        root.style.top = `${Math.max(4, Math.min(window.innerHeight - 40, dragging.top + (event.clientY - dragging.y)))}px`
        root.style.right = 'auto'
        root.style.bottom = 'auto'
      })
      header.addEventListener('pointerup', () => {
        dragging = null
      })

      root.append(header, tabs, body, actions)
      document.body.append(root)
      studio = { root, paint }
      paint()
    }

    /**
     * Add the floating launcher and, on click, the studio window.
     * @param t - the bound dictionary.
     * @returns a disposer.
     */
    function installFloatingStudio(t) {
      // A real document always has all three; the check keeps activation from
      // throwing in a host that has no DOM, and the launcher's dedupe genuinely
      // needs `querySelector`.
      if (
        typeof document === 'undefined' ||
        typeof document.body?.append !== 'function' ||
        typeof document.querySelector !== 'function'
      ) {
        return () => {}
      }
      if (document.querySelector(`[${STUDIO_MARK}="launcher"]`) !== null) return () => {}
      const launcher = document.createElement('button')
      launcher.type = 'button'
      launcher.setAttribute(STUDIO_MARK, 'launcher')
      launcher.textContent = '🎛'
      launcher.title = t('studioTitle')
      launcher.style.cssText =
        'position:fixed;z-index:2147482000;right:18px;bottom:18px;width:40px;height:40px;' +
        'font-size:18px;line-height:1;cursor:pointer;border-radius:20px;' +
        'border:1px solid var(--dsw-alias-border-l1,#d0d0d5);background:var(--dsw-alias-bg-base,#fff);' +
        'color:inherit;box-shadow:0 4px 16px rgba(0,0,0,0.18)'
      launcher.addEventListener('click', () => {
        openStudio(t).catch((error) => {
          launcher.title = `${t('studioFailed')}：${error.message}`
        })
      })
      document.body.append(launcher)
      return () => {
        launcher.remove()
        if (studio !== null) {
          studio.root.remove()
          studio = null
        }
      }
    }

    // ------------------------------------------------------- right sidebar tab --
    // The official right sidebar (harness >= 0.1.5) takes page types in two
    // stages: the type into `ctx.sidebarRightTabs`, its body into the keyed
    // `sidebar.right.pane.tab` seat under the type's `id`. This is the same public
    // path the wallpaper plugin and documentpreview use. The left panel stays the
    // full workbench; this tab is the narrow companion beside the chat.

    /** Identity in the tab system; also the key of the body registration. */
    const SIDE_TAB_ID = 'dsh-nai-imagegen/quick'
    /** Page kind that `openTab` names. */
    const SIDE_TAB_KIND = 'nai-imagegen'

    /**
     * Register the right-sidebar tab when the host has one.
     *
     * The seat only exists on hosts with the official right sidebar, so the
     * inject callback running at all is the capability check. The two services
     * are optional and may land after the seat, hence the short poll.
     * @param ctx - the client root context.
     * @param t - the bound dictionary.
     */
    function installSideTab(ctx, t) {
      if (!ctx?.slots || typeof ctx.slots.inject !== 'function') return
      const Body = () => {
        ensureSideStyles()
        return h(NaiPanel, { t, layout: 'side' })
      }
      const Icon = (props) => h(PanelIcon, { size: props?.size ?? 16 })
      ctx.slots.inject('sidebar.right.pane.tab', () => {
        let disposed = false
        let timer = 0
        let off = null
        const attempt = () => {
          if (disposed) return
          const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : null
          if (!tabs || typeof tabs.register !== 'function') {
            timer = setTimeout(attempt, 250)
            return
          }
          let disposeType = null
          let disposeBody = null
          try {
            disposeType = tabs.register({
              id: SIDE_TAB_ID,
              kind: SIDE_TAB_KIND,
              keepMounted: true,
              title: () => t('sideTab'),
              guide: [
                {
                  order: 120,
                  title: () => t('sideGuideTitle'),
                  description: () => t('sideGuideDesc'),
                  icon: Icon
                }
              ]
            })
            disposeBody = ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDE_TAB_ID }, Body)
          } catch (err) {
            try { if (disposeBody) disposeBody() } catch {}
            try { if (disposeType) disposeType() } catch {}
            console.warn('[dsh-nai-imagegen] right sidebar tab not registered:', err)
            return
          }
          off = () => {
            try { disposeBody() } catch {}
            try { disposeType() } catch {}
          }
        }
        attempt()
        return () => {
          disposed = true
          if (timer) clearTimeout(timer)
          if (off) off()
          off = null
        }
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-nai-imagegen: dictionaries')
      const t = ctx.locale.bind(NS)
      // The transcript scanner is opt-in (config `codeButtons`, default off).
      // This controller is the one switch shared by the startup check and the
      // panel toggle: on installs the observer, off disconnects and removes the
      // injected buttons.
      setBlockButtons = (enabled) => {
        const on = enabled === true
        if (on === blockButtonsActive) return
        if (on) {
          blockButtonsDispose = installCodeButtons(t)
          blockButtonsActive = true
        } else {
          if (typeof blockButtonsDispose === 'function') blockButtonsDispose()
          blockButtonsDispose = null
          blockButtonsActive = false
        }
      }
      ctx.effect(() => {
        api('/status')
          .then((status) => setBlockButtons(status.codeButtons === true))
          .catch(() => {})
        return () => setBlockButtons(false)
      }, 'dsh-nai-imagegen: prompt buttons')
      ctx.effect(() => installImageMenu(t), 'dsh-nai-imagegen: image menu')

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS
          },
          NaiPanel
        )
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            locale: NS,
            label: () => t('panel')
          },
          PanelIcon
        )
      )

      installSideTab(ctx, t)
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.NaiPanel = NaiPanel
    exports.PanelIcon = PanelIcon
    exports.looksLikePrompt = looksLikePrompt
    exports.hashOf = hashOf
    exports.decorate = decorate
    exports.installCodeButtons = installCodeButtons
    exports.installImageMenu = installImageMenu
    exports.markImage = markImage
    // Test seams for the auto-render bounds: the flag, a forced pass, and the
    // number of renders already spent against the session budget.
    exports.setAutoRender = (value) => {
      autoRender = value === true
    }
    exports.rescanBlocks = (options) => {
      if (typeof rescanBlocks === 'function') rescanBlocks(options)
    }
    exports.autoRenderedCount = () => autoDone.size
    exports.AUTO_RENDER_MAX = AUTO_RENDER_MAX
    return module.exports
  }
})
