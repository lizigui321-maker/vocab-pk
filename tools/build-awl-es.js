/*
 * build-awl-es.js — 生成 AWL 学术词书 + 西班牙语词书，合并进 public/data/books.json
 * 用法：node tools/build-awl-es.js
 * - AWL：Coxhead 学术词汇表 570 词，按 sublist 1-10 顺序（学术语料频率从高到低）
 *   释义优先从现有英语词书（toefl/kaoyan/ielts…）映射，缺失词用 MANUAL 词典补
 * - 西语：手写核心词汇（A1 / A2 各一本），按教学词频排序
 * 幂等：重复运行会先移除旧的同 id 词书再写入
 */
'use strict';
const fs = require('fs');
const path = require('path');
const BOOKS_FILE = path.join(__dirname, '..', 'public', 'data', 'books.json');

/* ---------- Coxhead AWL 570 headwords（sublist 顺序） ---------- */
const AWL = [
  // sublist 1 (60)
  'analyse','approach','area','assess','assume','authority','available','benefit','concept','consist',
  'constitute','context','contract','create','data','define','derive','distribute','economy','environment',
  'establish','estimate','evident','export','factor','finance','formula','function','identify','income',
  'indicate','individual','interpret','involve','issue','labour','legal','legislate','major','method',
  'occur','percent','period','policy','principle','proceed','process','require','research','respond',
  'role','section','sector','significant','similar','source','specific','structure','theory','vary',
  // sublist 2 (60)
  'achieve','acquire','administrate','affect','appropriate','aspect','assist','category','chapter','commission',
  'community','complex','compute','conclude','conduct','consequent','construct','consume','credit','culture',
  'design','distinct','element','equate','evaluate','feature','final','focus','impact','injure',
  'institute','invest','item','journal','maintain','normal','obtain','participate','perceive','positive',
  'potential','previous','primary','purchase','range','region','regulate','relevant','reside','resource',
  'restrict','secure','seek','select','site','strategy','survey','text','tradition','transfer',
  // sublist 3 (60)
  'alternative','circumstance','comment','compensate','component','consent','considerable','constant','constrain','contribute',
  'convene','coordinate','core','corporate','correspond','criteria','deduce','demonstrate','document','dominate',
  'emphasis','ensure','exclude','framework','fund','illustrate','immigrate','imply','initial','instance',
  'interact','justify','layer','link','locate','maximize','minor','negate','outcome','partner',
  'philosophy','physical','proportion','publish','react','register','rely','remove','scheme','sequence',
  'sex','shift','specify','sufficient','task','technical','technique','technology','valid','volume',
  // sublist 4 (60)
  'access','adequate','annual','apparent','approximate','attitude','attribute','civil','code','commit',
  'communicate','concentrate','confer','contrast','cycle','debate','despite','dimension','domestic','emerge',
  'error','ethnic','goal','grant','hence','hypothesis','implement','implicate','impose','integrate',
  'internal','investigate','job','label','mechanism','obvious','occupy','option','output','overall',
  'parallel','parameter','phase','predict','principal','prior','professional','project','promote','regime',
  'resolve','retain','series','statistic','status','stress','subsequent','sum','summary','undertake',
  // sublist 5 (60)
  'academy','adjust','alter','amend','aware','capacity','challenge','clause','compound','conflict',
  'consult','contact','decline','discrete','draft','enable','energy','enforce','entity','equivalent',
  'evolve','expand','expose','external','facilitate','fundamental','generate','generation','image','liberal',
  'licence','logic','margin','medical','mental','modify','monitor','network','notion','objective',
  'orient','perspective','precise','prime','psychology','pursue','ratio','reject','revenue','stable',
  'style','substitute','sustain','symbol','target','transit','trend','version','welfare','whereas',
  // sublist 6 (60)
  'abstract','accurate','acknowledge','aggregate','allocate','assign','attach','author','bond','brief',
  'capable','cite','cooperate','discriminate','display','diverse','domain','edit','enhance','estate',
  'exceed','expert','explicit','federal','fee','flexible','furthermore','gender','ignorant','incentive',
  'incidence','incorporate','index','inhibit','initiate','input','instruct','intelligence','interval','lecture',
  'migrate','minimum','ministry','motive','neutral','nevertheless','overseas','precede','presume','rational',
  'recover','reveal','scope','subsidy','tape','trace','transform','transport','underlie','utilise',
  // sublist 7 (60)
  'adapt','adult','advocate','aid','channel','chemical','classic','comprehensive','comprise','confirm',
  'contrary','convert','couple','decade','definite','deny','differentiate','dispose','dynamic','eliminate',
  'empirical','equip','extract','file','finite','foundation','globe','grade','guarantee','hierarchy',
  'identical','ideology','infer','innovate','insert','intervene','isolate','media','mode','paradigm',
  'phenomenon','priority','prohibit','publication','quote','release','reverse','simulate','sole','somewhat',
  'submit','successor','survive','thesis','topic','transmit','ultimate','unique','visible','voluntary',
  // sublist 8 (60)
  'abandon','accompany','accumulate','ambiguous','append','appreciate','arbitrary','automate','bias','chart',
  'clarify','commodity','complement','conform','contemporary','contradict','crucial','currency','denote','detect',
  'deviate','displace','drama','eventual','exhibit','exploit','fluctuate','guideline','highlight','implicit',
  'induce','inevitable','infrastructure','inspect','intense','manipulate','minimise','nuclear','offset','paragraph',
  'plus','practitioner','predominant','prospect','radical','random','reinforce','restore','revise','schedule',
  'tense','terminate','theme','thereby','uniform','vehicle','via','virtual','visual','widespread',
  // sublist 9 (60)
  'accommodate','analogy','anticipate','assure','attain','behalf','bulk','cease','coherent','coincide',
  'commence','compatible','concurrent','confine','controversy','converse','device','devote','diminish','distort',
  'duration','erode','ethic','format','found','inherent','insight','integral','intermediate','manual',
  'mature','mediate','medium','military','minimal','mutual','norm','overlap','passive','portion',
  'preliminary','protocol','qualitative','refine','relax','restrain','revolution','rigid','route','scenario',
  'sphere','subordinate','supplement','suspend','team','temporary','trigger','unify','violate','vision',
  // sublist 10 (30)
  'adjacent','albeit','assemble','collapse','colleague','compile','conceive','convince','depress','encounter',
  'enormous','forthcoming','incline','integrity','intrinsic','invoke','levy','likewise','nonetheless','notwithstanding',
  'odd','ongoing','panel','persist','pose','reluctance','so-called','straightforward','undergo','whereby',
];

/* 英式拼写 → 书里可能收录的美式拼写（查找释义时的别名） */
const ALIAS = {
  analyse: 'analyze', labour: 'labor', licence: 'license', utilise: 'utilize', minimise: 'minimize',
  administrate: 'administer', criteria: 'criterion', 'so-called': 'so',
};

/* 释义优先词典：查不到/需要覆盖时使用 */
const MANUAL = {
  analyse: 'v 分析；分解', administrate: 'v 管理；执行', labour: 'n 劳动；劳力；工党',
  legislate: 'v 立法；制定法律', licence: 'n 执照；许可证 v 许可',
  utilise: 'v 利用；使用', minimise: 'v 使减到最少；轻视',
  nonetheless: 'adv 尽管如此；然而', notwithstanding: 'prep 尽管 adv 尽管；仍然',
  'so-called': 'adj 所谓的；号称的', albeit: 'conj 虽然；尽管',
  whereby: 'adv 凭此；借以', forthcoming: 'adj 即将到来的；乐于提供的',
  incline: 'v 倾向于；倾斜 n 斜坡', levy: 'v 征收（税款）n 征税',
  invoke: 'v 援引；调用；祈求', pose: 'v 造成（问题等）n 姿势',
  reluctance: 'n 不情愿；勉强', odd: 'adj 奇怪的；奇数的；单个的',
  ongoing: 'adj 进行中的；持续的', panel: 'n 专门小组；面板；仪表板',
  persist: 'v 坚持；持续存在', adjacent: 'adj 邻近的；毗邻的',
  integrity: 'n 正直；完整；健全', intrinsic: 'adj 内在的；本质的',
  colleague: 'n 同事；同僚', depress: 'v 使沮丧；使萧条；按下',
  encounter: 'v 遭遇；偶然遇到 n 相遇', enormous: 'adj 巨大的；庞大的',
  compile: 'v 汇编；编纂', conceive: 'v 构想；设想；怀孕',
  convince: 'v 说服；使确信', collapse: 'v 倒塌；崩溃 n 崩溃',
  assemble: 'v 集合；装配；组装', undergo: 'v 经历；承受',
  straightforward: 'adj 简单明了的；直截了当的', criteria: 'n 标准（criterion 的复数）',
  conversely: 'adv 相反地', ethic: 'n 伦理；道德标准',
  integral: 'adj 必不可少的；完整的 n 积分', mediate: 'v 调解；斡旋',
  norm: 'n 标准；规范；常态', preliminary: 'adj 初步的；预备的',
  qualitative: 'adj 定性的；质量上的', rigid: 'adj 严格的；僵硬的',
  scenario: 'n 设想；方案；剧情梗概', sphere: 'n 领域；球体',
  subordinate: 'adj 下级的 n 下属 v 使服从', supplement: 'n 补充物 v 增补',
  suspend: 'v 暂停；悬浮；吊', trigger: 'v 触发；引发 n 扳机',
  unify: 'v 统一；使成一体', violate: 'v 违反；侵犯',
  vision: 'n 视力；愿景；想象力', converse: 'v 交谈 adj 相反的',
  devote: 'v 奉献；致力于', diminish: 'v 减少；缩小；贬低',
  distort: 'v 扭曲；歪曲', duration: 'n 持续时间',
  erode: 'v 侵蚀；削弱', format: 'n 格式 v 格式化',
  inherent: 'adj 固有的；内在的', insight: 'n 洞察力；深刻见解',
  intermediate: 'adj 中间的；中级的', manual: 'adj 手工的 n 手册',
  mature: 'adj 成熟的 v 成熟', military: 'adj 军事的 n 军队',
  minimal: 'adj 最小的；最低限度的', mutual: 'adj 相互的；共同的',
  overlap: 'v 重叠 n 重叠部分', passive: 'adj 被动的；消极的',
  portion: 'n 一部分；一份', protocol: 'n 协议；规程',
  refine: 'v 精炼；改进', relax: 'v 放松；松懈',
  restrain: 'v 抑制；限制', revolution: 'n 革命；巨变；旋转',
  route: 'n 路线；路径 v 按路线发送', team: 'n 团队；队伍',
  temporary: 'adj 暂时的；临时的', behalf: 'n 代表；利益（on behalf of 代表）',
  bulk: 'n 体积；大批；大部分', cease: 'v 停止；终止',
  coherent: 'adj 连贯的；条理清楚的', coincide: 'v 巧合；同时发生；一致',
  commence: 'v 开始；着手', compatible: 'adj 兼容的；合得来的',
  concurrent: 'adj 同时发生的；并存的', confine: 'v 限制；禁闭',
  controversy: 'n 争论；争议', analogy: 'n 类比；类似',
  anticipate: 'v 预期；预料', assure: 'v 保证；确保',
  attain: 'v 达到；获得', accommodate: 'v 容纳；适应；向…提供住处',
  device: 'n 装置；设备；手段', automate: 'v 使自动化',
  bias: 'n 偏见 v 使有偏见', chart: 'n 图表 v 绘制图表',
  clarify: 'v 澄清；阐明', commodity: 'n 商品；大宗货物',
  complement: 'v 补充 n 补充物', conform: 'v 遵守；符合',
  contemporary: 'adj 当代的 n 同时代人', contradict: 'v 反驳；与…矛盾',
  crucial: 'adj 至关重要的', currency: 'n 货币；通货',
  denote: 'v 表示；意味着', detect: 'v 察觉；探测',
  deviate: 'v 偏离；背离', displace: 'v 取代；迫使离开家园',
  drama: 'n 戏剧；戏剧性事件', eventual: 'adj 最终的',
  exhibit: 'v 展出；显示 n 展品', exploit: 'v 利用；剥削 n 功绩',
  fluctuate: 'v 波动；起伏', guideline: 'n 指导方针',
  highlight: 'v 强调；突出 n 亮点', implicit: 'adj 含蓄的；隐含的',
  induce: 'v 诱导；引起', inevitable: 'adj 不可避免的',
  infrastructure: 'n 基础设施', inspect: 'v 检查；视察',
  intense: 'adj 强烈的；紧张的', manipulate: 'v 操纵；熟练操作',
  nuclear: 'adj 核的；原子核的', offset: 'v 抵消 n 偏移',
  paragraph: 'n 段落', plus: 'prep 加上 n 加号',
  practitioner: 'n 从业者；开业医生', predominant: 'adj 主要的；占优势的',
  prospect: 'n 前景；可能性', radical: 'adj 激进的；根本的',
  random: 'adj 随机的', reinforce: 'v 加强；加固',
  restore: 'v 恢复；修复', revise: 'v 修改；复习',
  schedule: 'n 时间表 v 安排', tense: 'adj 紧张的 n 时态',
  terminate: 'v 终止；结束', theme: 'n 主题；题目',
  thereby: 'adv 由此；从而', uniform: 'adj 统一的 n 制服',
  vehicle: 'n 车辆；交通工具；媒介', via: 'prep 经由；通过',
  virtual: 'adj 虚拟的；事实上的', visual: 'adj 视觉的',
  widespread: 'adj 普遍的；广泛分布的', abandon: 'v 放弃；抛弃',
  accompany: 'v 陪伴；伴随', accumulate: 'v 积累；积聚',
  ambiguous: 'adj 模棱两可的', append: 'v 附加；追加',
  appreciate: 'v 欣赏；感激；理解', arbitrary: 'adj 任意的；武断的',
  century: 'n 世纪', institute: 'n 研究所；学院 v 建立',
  theory: 'n 理论；学说；原理', equate: 'v 等同；使相等', innovate: 'v 创新；革新',
};

/* ---------- 西班牙语核心词书：读取 es-words-raw.json（2599 词，频率排序） ---------- */
const ES_RAW = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'es-words-raw.json'), 'utf8'));
  } catch (e) {
    console.error('读取 es-words-raw.json 失败：' + e.message);
    return [];
  }
})();
const ES_A1 = [
  ['hola','int 你好'],['adiós','int 再见'],['buenos días','int 早上好'],['buenas tardes','int 下午好'],
  ['buenas noches','int 晚上好'],['gracias','int 谢谢'],['por favor','int 请'],['de nada','int 不客气'],
  ['perdón','int 对不起；打扰一下'],['sí','adv 是的'],['no','adv 不'],['hasta luego','int 回头见'],
  ['yo','pron 我'],['tú','pron 你'],['él','pron 他'],['ella','pron 她'],
  ['nosotros','pron 我们'],['vosotros','pron 你们'],['ellos','pron 他们'],['ellas','pron 她们'],
  ['usted','pron 您'],['esto','pron 这个；这'],['eso','pron 那个；那'],['aquí','adv 这里'],
  ['allí','adv 那里'],['ahora','adv 现在'],['hoy','adv 今天'],['ayer','adv 昨天'],
  ['mañana','adv/n 明天；早上'],['tarde','adv/n 晚；下午'],['noche','n 夜晚'],['día','n 白天；日子'],
  ['ser','v 是（表本质属性）'],['estar','v 在；（表状态）是'],['tener','v 有；拥有'],['haber','v 有（无人称 hay）'],
  ['hacer','v 做；制造'],['ir','v 去'],['venir','v 来'],['querer','v 想要；爱'],
  ['poder','v 能；可以'],['deber','v 应该'],['saber','v 知道；会'],['conocer','v 认识；了解'],
  ['decir','v 说'],['hablar','v 说话；讲'],['oír','v 听见'],['ver','v 看见'],
  ['mirar','v 看；瞧'],['comer','v 吃'],['beber','v 喝'],['dormir','v 睡觉'],
  ['vivir','v 生活；居住'],['abrir','v 打开'],['cerrar','v 关闭'],['comprar','v 买'],
  ['pagar','v 支付'],['dar','v 给'],['tomar','v 拿；喝；乘坐'],['poner','v 放置'],
  ['llevar','v 携带；穿；带去'],['buscar','v 寻找'],['encontrar','v 找到'],['pensar','v 想；思考'],
  ['creer','v 相信'],['preguntar','v 问'],['responder','v 回答'],['trabajar','v 工作'],
  ['estudiar','v 学习'],['escribir','v 写'],['leer','v 读'],['escuchar','v 听'],
  ['entender','v 理解；懂'],['aprender','v 学会；学习'],['empezar','v 开始'],['terminar','v 结束'],
  ['esperar','v 等待；希望'],['necesitar','v 需要'],['ayudar','v 帮助'],['llamar','v 叫；打电话'],
  ['salir','v 出去'],['entrar','v 进来'],['subir','v 上；上升'],['bajar','v 下；下降'],
  ['uno','num 一'],['dos','num 二'],['tres','num 三'],['cuatro','num 四'],
  ['cinco','num 五'],['seis','num 六'],['siete','num 七'],['ocho','num 八'],
  ['nueve','num 九'],['diez','num 十'],['once','num 十一'],['doce','num 十二'],
  ['veinte','num 二十'],['treinta','num 三十'],['cincuenta','num 五十'],['cien','num 一百'],
  ['mil','num 一千'],['familia','n 家庭'],['padre','n 父亲'],['madre','n 母亲'],
  ['hermano','n 兄弟'],['hermana','n 姐妹'],['hijo','n 儿子'],['hija','n 女儿'],
  ['abuelo','n 爷爷；外公'],['abuela','n 奶奶；外婆'],['tío','n 叔叔；舅舅'],['tía','n 阿姨；姑姑'],
  ['esposo','n 丈夫'],['esposa','n 妻子'],['amigo','n 朋友'],['amiga','n 女性朋友'],
  ['novio','n 男朋友'],['novia','n 女朋友'],['niño','n 男孩；小孩'],['niña','n 女孩'],
  ['hombre','n 男人'],['mujer','n 女人'],['persona','n 人'],['gente','n 人们'],
  ['nombre','n 名字'],['señor','n 先生'],['señora','n 女士'],['tiempo','n 时间；天气'],
  ['hora','n 小时；时刻'],['minuto','n 分钟'],['semana','n 星期；周'],['mes','n 月份'],
  ['año','n 年'],['lunes','n 星期一'],['martes','n 星期二'],['miércoles','n 星期三'],
  ['jueves','n 星期四'],['viernes','n 星期五'],['sábado','n 星期六'],['domingo','n 星期日'],
  ['primavera','n 春天'],['verano','n 夏天'],['otoño','n 秋天'],['invierno','n 冬天'],
  ['comida','n 食物；饭'],['agua','n 水'],['pan','n 面包'],['leche','n 牛奶'],
  ['café','n 咖啡'],['té','n 茶'],['vino','n 葡萄酒'],['cerveza','n 啤酒'],
  ['carne','n 肉'],['pescado','n 鱼'],['pollo','n 鸡肉'],['huevo','n 鸡蛋'],
  ['arroz','n 米饭'],['fruta','n 水果'],['manzana','n 苹果'],['naranja','n 橙子'],
  ['plátano','n 香蕉'],['verdura','n 蔬菜'],['tomate','n 西红柿'],['patata','n 土豆'],
  ['azúcar','n 糖'],['sal','n 盐'],['queso','n 奶酪'],['sopa','n 汤'],
  ['desayuno','n 早餐'],['almuerzo','n 午餐'],['cena','n 晚餐'],['restaurante','n 餐馆'],
  ['cuchara','n 勺子'],['tenedor','n 叉子'],['cuchillo','n 刀'],['vaso','n 杯子（无把）'],
  ['taza','n 杯子（带把）'],['color','n 颜色'],['rojo','adj 红色的'],['azul','adj 蓝色的'],
  ['verde','adj 绿色的'],['amarillo','adj 黄色的'],['blanco','adj 白色的'],['negro','adj 黑色的'],
  ['gris','adj 灰色的'],['marrón','adj 棕色的'],['cuerpo','n 身体'],['cabeza','n 头'],
  ['cara','n 脸'],['ojo','n 眼睛'],['oreja','n 耳朵'],['nariz','n 鼻子'],
  ['boca','n 嘴'],['diente','n 牙齿'],['mano','n 手'],['brazo','n 手臂'],
  ['pie','n 脚'],['pierna','n 腿'],['corazón','n 心；心脏'],['pelo','n 头发'],
  ['casa','n 房子；家'],['puerta','n 门'],['ventana','n 窗户'],['mesa','n 桌子'],
  ['silla','n 椅子'],['cama','n 床'],['cocina','n 厨房'],['baño','n 浴室'],
  ['habitación','n 房间'],['teléfono','n 电话'],['llave','n 钥匙'],['luz','n 灯；光'],
  ['ciudad','n 城市'],['pueblo','n 小镇；村庄'],['calle','n 街道'],['plaza','n 广场'],
  ['tienda','n 商店'],['mercado','n 市场'],['hospital','n 医院'],['escuela','n 学校'],
  ['universidad','n 大学'],['banco','n 银行'],['parque','n 公园'],['estación','n 车站'],
  ['aeropuerto','n 机场'],['hotel','n 酒店'],['coche','n 汽车'],['autobús','n 公共汽车'],
  ['tren','n 火车'],['bicicleta','n 自行车'],['avión','n 飞机'],['billete','n 票'],
  ['viaje','n 旅行'],['camino','n 路；道路'],['mapa','n 地图'],['sol','n 太阳'],
  ['luna','n 月亮'],['cielo','n 天空'],['mar','n 海'],['río','n 河'],
  ['montaña','n 山'],['árbol','n 树'],['flor','n 花'],['animal','n 动物'],
  ['perro','n 狗'],['gato','n 猫'],['pájaro','n 鸟'],['libro','n 书'],
  ['dinero','n 钱'],['trabajo','n 工作'],['palabra','n 单词；话'],['pregunta','n 问题'],
  ['respuesta','n 回答'],['cosa','n 东西；事情'],['lugar','n 地方'],['mundo','n 世界'],
  ['país','n 国家'],['puerta de... no','x 占位'], // 占位行，构建时剔除
];

const ES_A2 = [
  ['oficina','n 办公室'],['profesor','n （男）教师'],['profesora','n （女）教师'],['médico','n 医生'],
  ['abogado','n 律师'],['ingeniero','n 工程师'],['policía','n 警察'],['peluquería','n 理发店'],
  ['zapato','n 鞋'],['ropa','n 衣服'],['camisa','n 衬衫'],['pantalones','n 裤子'],
  ['vestido','n 连衣裙'],['abrigo','n 大衣'],['gafas','n 眼镜'],['reloj','n 钟表'],
  ['anillo','n 戒指'],['boda','n 婚礼'],['fiesta','n 聚会；节日'],['regalo','n 礼物'],
  ['música','n 音乐'],['película','n 电影'],['canción','n 歌曲'],['fotografía','n 照片'],
  ['bailar','v 跳舞'],['cantar','v 唱歌'],['tocar','v 弹奏；触摸'],['cocinar','v 做饭'],
  ['limpiar','v 打扫'],['lavar','v 洗'],['planchar','v 熨烫'],['volver','v 返回'],
  ['llegar','v 到达'],['perder','v 丢失；输掉'],['ganar','v 赢；挣得'],['jugar','v 玩；打球'],
  ['correr','v 跑'],['caminar','v 走路；散步'],['saltar','v 跳'],['nadar','v 游泳'],
  ['viajar','v 旅行'],['conducir','v 驾驶'],['aparcar','v 停车'],['seguir','v 跟随；继续'],
  ['conseguir','v 获得；设法做到'],['explicar','v 解释'],['mostrar','v 展示；给…看'],['enseñar','v 教'],
  ['recordar','v 记得'],['olvidar','v 忘记'],['reír','v 笑'],['llorar','v 哭'],
  ['sentir','v 感到；遗憾'],['preferir','v 更喜欢'],['elegir','v 选择'],['decidir','v 决定'],
  ['cambiar','v 改变；更换'],['gastar','v 花费（钱）'],['ahorrar','v 节省；存钱'],['permitir','v 允许'],
  ['prohibir','v 禁止'],['costar','v 花费；值（多少钱）'],['compartir','v 分享'],['comparar','v 比较'],
  ['describir','v 描述'],['dibujar','v 画画'],['firmar','v 签字'],['imprimir','v 打印'],
  ['enviar','v 发送；寄'],['recibir','v 收到'],['contestar','v 回复；回答'],['invitar','v 邀请'],
  ['visitar','v 参观；拜访'],['conversación','n 对话；会话'],['noticia','n 新闻；消息'],['periódico','n 报纸'],
  ['revista','n 杂志'],['carta','n 信；纸牌'],['mensaje','n 消息；短信'],
  ['bebida','n 饮料'],['plato','n 盘子；一道菜'],['postre','n 甜点'],['helado','n 冰淇淋'],
  ['zumo','n 果汁'],['mantequilla','n 黄油'],['aceite','n 油'],['harina','n 面粉'],
  ['pescado y marisco','x 占位'], // 占位行，构建时剔除
  ['museo','n 博物馆'],['cine','n 电影院'],['teatro','n 剧院'],['piscina','n 游泳池'],
  ['gimnasio','n 健身房'],['biblioteca','n 图书馆'],['farmacia','n 药店'],['frontera','n 边界'],
  ['embajada','n 大使馆'],['emoción','n 情感；激动'],['amor','n 爱；爱情'],['miedo','n 害怕；恐惧'],
  ['esperanza','n 希望'],['suerte','n 运气'],['felicidad','n 幸福'],['tristeza','n 悲伤'],
  ['enfermo','adj 生病的'],['resfriado','n 感冒'],['dolor','n 疼痛'],['fiebre','n 发烧'],
  ['medicina','n 药；医学'],['pastilla','n 药片'],['salud','n 健康'],['aburrido','adj 无聊的'],
  ['interesante','adj 有趣的'],['importante','adj 重要的'],['necesario','adj 必要的'],['posible','adj 可能的'],
  ['imposible','adj 不可能的'],['seguro','adj 安全的；肯定的'],['peligroso','adj 危险的'],['útil','adj 有用的'],
  ['caro','adj 贵的'],['barato','adj 便宜的'],['libre','adj 空闲的；自由的'],['ocupado','adj 忙的'],
  ['lleno','adj 满的'],['vacío','adj 空的'],['mismo','adj 同样的'],['otro','adj 另一个的'],
  ['varios','adj 好几个的'],['dulce','adj 甜的'],['salado','adj 咸的'],['picante','adj 辣的'],
  ['casi','adv 几乎'],['solo','adv 仅仅；单独地'],['todavía','adv 还；仍然'],['ya','adv 已经'],
  ['luego','adv 然后'],['después','adv 之后'],['antes','adv 之前'],['pronto','adv 很快；早'],
  ['deprisa','adv 快速地'],['despacio','adv 缓慢地'],['encima','adv 在上面'],['debajo','adv 在下面'],
  ['delante','adv 在前面'],['detrás','adv 在后面'],['alrededor','adv 在周围'],['juntos','adv 一起'],
  ['cuánto','pron 多少'],['cuándo','adv 什么时候'],['dónde','adv 哪里'],['quién','pron 谁'],
  ['por qué','adv 为什么'],['porque','conj 因为'],['pero','conj 但是'],['aunque','conj 虽然'],
  ['también','adv 也'],['tampoco','adv 也不'],['muy','adv 很'],['mucho','adj/adv 很多'],
  ['poco','adj/adv 很少'],['más','adv 更多；较'],['menos','adv 更少'],['siempre','adv 总是'],
  ['nunca','adv 从不'],['a veces','adv 有时候'],['bien','adv 好'],['mal','adv 不好'],
  ['de','prep …的；来自'],['en','prep 在…里；在…时'],['a','prep 到；向'],['con','prep 和…一起；用'],
  ['por','prep 为了；通过'],['para','prep 为了；给'],['sin','prep 没有'],['sobre','prep 在…上面；关于'],
  ['entre','prep 在…之间'],['desde','prep 从；自'],['hasta','prep 直到'],
  ['contra','prep 反对'],['según','prep 根据'],['durante','prep 在…期间'],['cerca','adv 在附近'],
  ['lejos','adv 在远处'],['feliz','adj 幸福的；快乐的'],['triste','adj 悲伤的'],['contento','adj 高兴的'],
  ['cansado','adj 累的；疲倦的'],['enfadado','adj 生气的'],['rico','adj 富有的；美味的'],['pobre','adj 贫穷的'],
  ['fuerte','adj 强壮的；强烈的'],['débil','adj 弱的'],['limpio','adj 干净的'],['sucio','adj 脏的'],
  ['joven','adj 年轻的'],['viejo','adj 年老的；旧的'],['rápido','adj 快的'],['lento','adj 慢的'],
  ['caliente','adj 热的'],['frío','adj 冷的'],['fácil','adj 容易的'],['difícil','adj 困难的'],
  ['bonito','adj 漂亮的'],['feo','adj 丑的'],['nuevo','adj 新的'],['pequeño','adj 小的'],
  ['grande','adj 大的'],['alto','adj 高的'],['bajo','adj 矮的；低的'],['largo','adj 长的'],
  ['corto','adj 短的'],['bueno','adj 好的'],['malo','adj 坏的'],['todo','adj/pron 全部的；一切'],
  ['algo','pron 某事；某物'],['nada','pron 什么也没有'],['alguien','pron 某人'],['nadie','pron 没有人'],
];

/* ---------- 构建 ---------- */
function main() {
  const books = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));
  /* 释义查找表：小写词 -> 释义（优先收录大词书） */
  const PRIORITY = ['toefl', 'kaoyan', 'ielts', 'cet6', 'cet4', 'gaokao', 'zhongkao', 'kaoyan-core', 'ielts-core', 'cet6-core', 'cet4-core'];
  const dict = new Map();
  for (const pid of PRIORITY) {
    const b = books.find((x) => x.id === pid);
    if (!b) continue;
    for (const [w, m] of b.words) {
      const k = String(w).toLowerCase();
      if (!dict.has(k)) dict.set(k, m);
    }
  }
  const missing = [];
  const awlWords = AWL.map((w) => {
    const k = w.toLowerCase();
    let m = dict.get(k) || dict.get((ALIAS[k] || '').toLowerCase()) || MANUAL[k];
    if (!m) { missing.push(w); m = 'n （待补释义）'; }
    return [w, m];
  });

  const esAll = ES_RAW.map(([w, m]) => [String(w), String(m)]);

  /* 幂等写入 */
  const filtered = books.filter((b) => !['awl', 'es-a1', 'es-a2', 'es'].includes(b.id));
  filtered.push({ id: 'awl', name: '学术词汇 AWL（学术英语高频 570 词）', lang: 'en', keepOrder: true, words: awlWords });
  filtered.push({ id: 'es', name: '西班牙语常用 2000 词', lang: 'es', keepOrder: true, words: esAll });
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(filtered, null, 0), 'utf8');

  console.log('AWL: ' + awlWords.length + ' 词（sublist 顺序）');
  console.log('西语: ' + esAll.length + ' 词（频率排序）');
  console.log('books.json 现共 ' + filtered.length + ' 本词书');
  if (missing.length) {
    console.log('\n⚠️ AWL 缺释义 ' + missing.length + ' 词（已用占位，需补 MANUAL）：');
    console.log(missing.join(', '));
  }
}
main();
