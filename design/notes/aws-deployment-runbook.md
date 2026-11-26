# AWS 自建部署运维手册

> 部署到**新账号**请看 [`infra-aws/DEPLOY.md`](../../infra-aws/DEPLOY.md)(脚本 `infra-aws/scripts/deploy.sh`)。
> 本手册里尖括号内的值(安全组、用户池等)换成你自己实例的;日常更新也可以直接重跑那个脚本。

面向已经部署好的实例。设计文档在 `design/superpowers/specs/2026-08-17-cap-aws-selfhost-design.md`，
实施计划在 `design/superpowers/plans/2026-08-17-cap-aws-selfhost.md`。

## 部署命令

**两个 context 参数都是必需的。** 漏掉 `cfVpcOriginSgId` 会让 ALB 的入站规则消失，
CloudFront 随即对所有请求返回 504——而且 `cdk deploy` 会成功，不会报错。

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat ~/.cap-cf-keys/public_key.pem)"
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) bunx cdk deploy \
  --output cdk.out.deploy \
  -c cfVpcOriginSgId=<cloudfront-vpc-origin-sg-id> \
  --require-approval never --outputs-file outputs.json
```

`--output cdk.out.deploy` 不是可选的洁癖：如果别的进程同时在读默认的 `cdk.out`
（例如有人在跑 `bunx vitest run`，每个 CDK 测试都会 synth 一次栈），deploy 会以
"Other CLIs are currently reading from cdk.out" 中止，**并且返回退出码 0**。

`cfVpcOriginSgId` 的值可以这样查（它是 AWS 在首次创建 VPC origin 时自动建的托管安全组）：

```bash
aws ec2 describe-security-groups \
  --filters Name=group-name,Values=CloudFront-VPCOrigins-Service-SG \
  --query 'SecurityGroups[0].GroupId' --output text --region us-east-1
```

### 首次部署到空账号时

服务需要镜像才能健康，镜像又需要 App CloudFront 的域名（`NEXT_PUBLIC_WEB_URL`
是构建期烧进产物的）。用 `-c skipTasks=true` 打破这个循环：

1. `cdk deploy -c skipTasks=true -c cfVpcOriginSgId=...` — 两个服务以 0 任务建成，栈快速完成
2. 从 `outputs.json` 取 `AppUrl`，构建并推送镜像（见下）
3. 不带 `skipTasks` 再部署一次 — 任务扩到 1 并拉取镜像

镜像已存在时不需要 `skipTasks`。

## 构建镜像

```bash
./infra-aws/scripts/build-images.sh <account> <web-repo> <media-repo> <web-url> [whisper-repo]
```

**不要用管道接 `tail`**。脚本内部有 `set -euo pipefail`，但外层管道会吞掉它的
退出码，失败的构建会显示成 exit 0。重定向到文件再看：

```bash
./infra-aws/scripts/build-images.sh ... > /tmp/build.log 2>&1; echo "EXIT: $?"
```

cap-web 必须带真实的 `NEXT_PUBLIC_WEB_URL` 构建。用上游发布的 ghcr 镜像会把
`localhost:3000` 内联进所有分享链接和嵌入代码——`apps/web/Dockerfile` 原本把它写死成
ENV，我们改成了 ARG。

第五个参数（whisper 仓库）是可选的；省略时跳过 whisper 镜像。whisper 镜像约 2.57 GB，
`medium` 模型权重烧在里面，只有改了 `apps/whisper-server/` 才需要重建。

**改 whisper 的 Python 依赖会让模型层失效。** `Dockerfile` 里 `pyproject.toml` / `uv.lock`
在模型 bake 之前 COPY（必须如此——bake 要用已安装的 `faster_whisper`），所以任何依赖变动
都会触发重新下载约 1.5 GB 权重，构建要多花几分钟。只改 `src/` 不会。

**web 镜像构建突然失败、报 postcss / `__turbopack_context__.a is not a function`,先清 build cache。**
`apps/web/Dockerfile` 挂了一个持久的 Bun 安装缓存
(`--mount=type=cache,id=bun-1.4.4,...`)。那个缓存里一旦有包损坏,`bun install --frozen-lockfile`
会装出一棵坏的 node_modules,构建就**稳定复现**地失败,而且报错指向 postcss / source map,
和你改的代码毫无关系(症状里还会出现 `failed to read input source map`)。

```bash
docker builder prune -af   # 会清掉 cache mount
```

判断依据:错误位置和你的改动无关,且**上一次构建成功、期间没有改过 `bun.lock`**。
实际踩过一次:改的是三个 `.ts` 文件,报错却在 `postcss.config.js`。

**说话人识别(diarization)。** `apps/whisper-server/src/diarize.py`,走 ONNX Runtime
(faster-whisper 的 VAD 已经带了它),**不引入 PyTorch** —— 权重约 34 MB,而 torch 要约 2 GB。
速度 0.09 倍实时,6 分钟录制约 30 秒。

模型和阈值是**实测选出来的**,拿 sherpa-onnx 的参考音频(4 人中文、2 人英文)扫 0.40–0.90:

| embedding | 中文(应为 4) | 英文(应为 2) |
|---|---|---|
| 3dspeaker eres2net zh-cn | 阈值不把英文压成 1 就永远不是 4 | — |
| **3dspeaker CAM++ zh-cn** | **0.55–0.75 全对** | **全程正确** |

取 0.65(平台中间而非边缘)。改阈值前请用同样两段音频复测。

关掉:`DIARIZATION_ENABLED=0`。模型缺失或失败时自动降级成"无说话人",**不会影响转写**。

**说话人分离在长录制上不可用,超过 10 人就整体丢弃。** 固定阈值聚类的失效方式不是"报错",
而是**凭空造说话人**,而且越长越糟。拿真实素材实测(真值 4 人):

| 录制时长 | 自动检测出的说话人数 |
|---|---|
| 57 秒参考音频 | 4(正确) |
| 31 分钟 | 24 |
| 50 分钟 | 62(阈值 0.75)/ **80**(线上 0.65) |

**四种修补都试过、都不行,不要再试:**

- 提高阈值:0.75/0.80 在 31 分钟上仍是 23–24 类,而 0.80 会把 4 人参考音频压成 3
- 提高 `min_duration_on`:24 → 14 类,但**丢掉 16% 的真实语音**,前几名占比毫无变化
- 指定真实人数(`num_clusters=4`):出 4 个标签,但占比塌成 88/5/4/2,把其他人吸进主簇
- **换聚类算法**:自己用 `SpeakerEmbeddingExtractor` 提嵌入(不需要 torch),换成
  scikit-learn 的层次聚类(cosine + average linkage),n=4 得到 **91/5/4/0**,自动模式
  th=0.7 得到 13 类 —— **比原来更差**

所以 `DIARIZATION_MAX_SPEAKERS`(默认 10)超了就返回空,**没有标签好过错的标签** ——
字幕是 AI 摘要的输入,`Speaker S82` 会一路污染到摘要里。

### 根因:单个远场麦克风下,嵌入是按"离麦克风多远"聚的,不是按人

两种完全不同的聚类算法(贪心、层次)在同一批嵌入上都收敛到"一簇占九成",所以问题**不在
聚类算法,在嵌入本身**。在那段 50 分钟、同一房间 4 人的录制上直接量:

```
366 段可嵌入语音,平均 7.6 秒(长度足够),语音覆盖 46.4/50.3 分钟 = 92%

两两余弦距离:  p5 0.204   中位数 0.692   p95 0.936
silhouette (n=2..5):  +0.26 / +0.22 / +0.27 / +0.25

按 n=4 聚类后,每簇的平均电平:
  cluster 0: 287 段, 42.4 分钟, -31.4 dBFS   ← 91% 的语音
  cluster 1:  53 段,  1.9 分钟, -24.7 dBFS   ← 比它响 7 dB
  cluster 3:  25 段,  2.2 分钟, -30.3 dBFS
```

分得开的音频,距离分布应该是双峰的(同人 0.1–0.3、不同人 0.6+);这里中位数 0.692、
只有 5% 的配对接近,silhouette 也只有 0.2 出头 —— 嵌入是散开的噪声,不是四个紧密的团。

**决定性的一条:唯一被干净分出来的簇是最响的那簇(离麦克风最近的人),只占 1.9 分钟,
其余三人全挤进同一簇。** 同房间同麦克风,较远的几个人共享完全相同的房间混响和信道特征,
而 CAM++ 是在近场语音上训练的,嵌入被信道特征主导、压过嗓音差异。这就是语音领域的
single distant microphone 问题。

**换 pyannote.audio 会好一些但不解决问题。** 它的嵌入模型(WeSpeaker ResNet34)训练时加了
混响增强,对远场更鲁棒;但公开的 AMI 单远场麦克风基准上,即使最好的系统 DER 也在 25–30%,
即约四分之一的时间标错人。代价是镜像 2.71 → 约 5 GB、diarization 从 0.09× 掉到 1–3× 实时
(50 分钟录制从 6 分钟变成 50–150 分钟)。**投这个代价前先想清楚"四分之一标错"能不能用。**

真正有杠杆的是采集方式:让每个人从自己的设备接入通话,各自经过独立通道,信道差异反而帮忙。
桌面阵列麦克风会改善一些,但仍是单一混合轨。

**注:左右声道相关系数 1.0000 只说明是单声道源,不能推出"其他人没被录到"。**
一个房间里一支麦克风录 4 个人,本来就是 1.0000,而 4 个人的声音都在文件里。判断
System Audio 有没有开可以用它,但不要据此判断说话人是否被采集到:

```bash
ffmpeg -v error -i <audio> -t 300 -ac 2 -ar 16000 -f s16le /tmp/st.raw -y
# 相关系数 1.0000 → 单声道源(可能是"只有麦克风",也可能是"同房间一支麦克风")
```

**whisper 输出 key 带流水线版本号,改了流水线语义就要升版本。**
`whisperOutputKey` 现在产出 `whisper.words.v2.json`。workflow 会**复用已存在的输出而不重新起
任务**(两条路径 + 步骤重试曾导致同时 4 个任务抢写同一对象,最后完成的覆盖其余),而复用
安全的前提就是这个版本号:旧流水线的产物在旧 key 下,永远不会被找到。改了模型、分词合并、
简繁转换或 diarization,就把 `WHISPER_OUTPUT_VERSION` 加一。

说话人是通过 **VTT 里的 `Speaker A:` 前缀**传下去的 —— 这是唯一的通道,因为字幕面板和
AI 摘要都读 `transcription.vtt`。不用 WebVTT 的 `<v A>` 语音跨度,因为 `parseVTT` 是手写的、
不处理标签,会把 `<v A>` 原样显示出来。

**中文转写会被转成简体。** Whisper 对 `zh` 默认输出繁体，`src/simplified.py` 用 OpenCC
`t2s` 在解码后转换，按**检测到的**语言（`info.language`）判断而非请求的语言（请求通常是
`auto`）。用 `t2s` 而不是 `tw2sp`：后者还会替换地区词汇（記憶體→内存），转写必须保持说话人
实际说的词。非中文完全跳过，不加载转换字典。

## 用户管理

自助注册已关闭（`AllowAdminCreateUserOnly: true`），只能管理员创建：

```bash
POOL=<user-pool-id>   # stack 输出 CognitoIssuer 的最后一段
aws cognito-idp admin-create-user --user-pool-id $POOL \
  --username <邮箱> \
  --user-attributes Name=email,Value=<邮箱> Name=email_verified,Value=true \
  --message-action SUPPRESS --region us-east-1
aws cognito-idp admin-set-user-password --user-pool-id $POOL \
  --username <邮箱> --password '<密码>' --permanent --region us-east-1
```

`--message-action SUPPRESS` 是因为没有配置邮件发送，欢迎邮件发不出去。

**`email_verified=true` 不能省。** 登录走的是上游的通用 OIDC provider(`OIDC_ISSUER` 指向这个
用户池),它要求 ID token 里 `email_verified` 严格等于 `true`,否则拒绝登录并跳到
`/login?error=OidcEmailUnverified`。漏了的用户补上:

```bash
aws cognito-idp admin-update-user-attributes --user-pool-id $POOL --username <邮箱> \
  --user-attributes Name=email_verified,Value=true --region us-east-1
```

2026-11 之前用的是 fork 自己加的 `CognitoProvider`(provider id `cognito`)。切换后老用户第一次
登录时会按已验证邮箱自动关联到原来的 user,`accounts` 表里留一条 `cognito` 的旧记录,无害。

## 部署后需要手工填的两个 secret

CDK 建的是空壳，值必须手工写入。原因分别是：CloudFront 私钥必须与 CDK 里的公钥配对，
而 `DATABASE_URL` 若在 CDK 里拼装会把明文密码落进 ECS task definition。

`DATABASE_URL` 的形式（注意 `ssl=Amazon%20RDS`，见下节）：

```
mysql://capadmin:<urlencoded-password>@<aurora-endpoint>:3306/cap?ssl=Amazon%20RDS
```

## 转写后端:Amazon Transcribe(Whisper 作回退)

2026-11 起批处理转写走 **Amazon Transcribe**(`TRANSCRIPTION_BACKEND=transcribe`,CDK 里给 cap-web 设的)。
拿两场真实中文会议(64 / 80 分钟)和 Whisper medium 对比过:

| | Whisper medium(CPU) | Amazon Transcribe |
|---|---|---|
| 耗时 | 约 1 小时 / 1 小时 45 分 | **6 / 7 分钟** |
| 说话人 | 48 / 91 人(只能丢弃) | **4 / 7 人**,占比合理 |
| 标点 | 64 分钟那段一个都没有 | 完整 |
| 中文术语 | "工单"写成"公单""功单" | 正确 |
| 中英混说 | **好**(Agent、GraphRAG、schema) | 弱:写成 gent / MOC,甚至漏掉 |
| LLM 盲评(24 个时间窗) | 10 | 14 |

成本约 $1.44 / 小时音频(Whisper 几乎为零)。代码在 `apps/web/lib/aws-transcribe.ts`,结果映射成
`WhisperResult` 形状,下游字幕 / 总结 / 问答不变。

- **任务名**按视频和用途固定:`cap-<videoId>-transcript-v1` / `cap-<videoId>-edit-transcript-v1`;输出写到
  `<userId>/<videoId>/transcribe.<purpose>.v1.json`,存在就直接复用(重试、两条转写路径都收敛到同一个任务)。
  失败的或输出被删掉的任务会被删除后重开。**要强制重转**:删掉这个输出文件,再在分享页点 Retry。
- **语言**:始终自动识别,候选 `TRANSCRIBE_LANGUAGE_OPTIONS`(默认 `zh-CN,en-US`)。视频的"AI 语言"设置是
  总结用的语言、不一定是说话的语言,所以只加入候选、不强制。
- **IAM 的坑:`StartTranscriptionJob` 没有资源级权限**(服务授权参考里资源类型为空),按任务 ARN 收窄会直接
  AccessDenied。现在是 `Resource: *` + 条件 `transcribe:OutputBucketName = 录像桶`;Get / Delete 收窄到 `cap-*`。
- **切回 Whisper**:去掉 `TRANSCRIPTION_BACKEND`(或设成 `whisper`)再 `cdk deploy`。Whisper 任务本身一直保留,
  画面时间线的抽关键帧(`TASK_MODE=keyframes`)也还靠它。
- 用户自配 S3 桶的视频同 Whisper 一样不支持(输入输出都按本桶读写)。

## 视频问答(Ask 标签页)

分享页的 Ask 标签页基于视频内容回答问题,回答里的 `[mm:ss]` 可点击跳转。全部是 fork 自有代码:
`apps/web/lib/video-qa/`、`apps/web/workflows/visual-timeline.ts`、
`apps/web/app/api/videos/[videoId]/ask/route.ts`、`apps/web/app/s/[videoId]/_components/tabs/Ask.tsx`、
`apps/whisper-server/src/keyframes.py`。

**两段式:离线理解一次,问答时只读文字。** 不在提问时把原视频喂给模型(长视频超限、慢、没时间戳)。

1. 转写完成后(`transcribe.ts` 里 `queueVisualTimeline`),或老视频第一次被提问时,`ensureVisualTimeline`
   启动 `visualTimelineWorkflow`:
   - 复用 Whisper ECS 任务,`TASK_MODE=keyframes`:每秒一张 64×36 灰度图做变化检测,画面停稳后取帧,
     静止画面每 90 秒补一帧,超过 200 张时提高阈值;另每 10 秒一张网格帧供 `look_at` 用。1280px JPEG。
     实测 64 分钟录制:155 张关键帧 / 489 帧 / 35 MB。
   - 关键帧约 10 张一批,连同该时间窗的字幕交给 `generation` 模型(Sonnet 5.5),产出画面描述 +
     **原样照抄的屏幕文字**。
2. 提问时 `POST /api/videos/<id>/ask`:带时间戳的完整字幕 + 画面时间线 + 总结/章节作为一个**带缓存点的
   system 块**交给 `chat-streaming` 模型(Opus 5.5),追问走缓存读。模型可调 `look_at(start,end)` 看已存的帧
   (每次最多 6 张、每个回答最多 3 次)。

**S3 产物**(都在 `<userId>/<videoId>/` 下):`frames.v1.json`(帧索引,任务最后写,是完成信号)、
`frames/v1/*.jpg`、`visual.timeline.v1.json`、`visual.timeline.lock`(防重复启动,3 小时过期,跑完删除)。

**权限与 Q&A 开关:** 必须登录(否则 401),再走 `VideosPolicy.canView`(含视频/空间密码);字幕被隐藏
(`disableTranscript`,含空间规则)时问答一并关闭,因为回答会引用字幕。按用户的内存限流 12 次/分钟。

**整个实例要求登录才能看视频:** `CAP_REQUIRE_SIGN_IN_TO_VIEW=true`(CDK 里给 cap-web 设的)。
`decideCanView` 在所有规则之前拒绝匿名用户(reason `sign_in_required`),视频设成公开、链接"任何人可访问"、
邮箱域例外都不再放行;已登录用户照旧按原规则(私有仍私有、密码仍要输)。
**有四条路径不走 VideosPolicy,各自单独加了判断**(`lib/sign-in-required.ts`):`/api/video/og`(只给锁图)、
`getPublicShareVideo`(oEmbed / Slack 展开 / Iframely)、公开合集 `/c/[id]`、`/api/video/domain-info`。
**新增任何自己判断可见性的路径时也要调用 `isSignInRequiredToView()`**,否则就是一个匿名可见的口子。
这个开关直接读 `process.env`,不走 `serverEnv()` —— 后者校验整套 schema,而 `VideosPolicy` 会在只配了
部分 env 的测试/脚本里被构造。已签发的媒体签名 URL 最长 1 小时后失效;App 分发不缓存,无需清 CDN。

**重建画面时间线:** 删掉 `visual.timeline.v1.json`(只重做描述)或连同 `frames.v1.json` 一起删(重新抽帧),
再在 Ask 里提一个问题即可触发。若卡住,检查是否残留了 `visual.timeline.lock`。

**排查日志:** `[visual-timeline]`(帧数、批次数、保存的片段数、失败的时间窗)、
`[video-qa] <id> <model>: N steps, usage {...}`(含 `cacheReadTokens`,确认缓存生效)。
Whisper 日志组里 `wrote N frames (K keyframes)`。

**限制:** 用户自配 S3 桶的视频没有画面时间线(Whisper 任务角色只能访问本桶),只有基于字幕的回答;
截图类视频没有 Ask;上下文上限约 70 万字符,超过返回 413。

### 会议材料与问答历史

Ask 标签页顶部的 "Meeting materials":视频所有者和**视频所属组织的成员**可以上传/删除,能看视频的人都能
下载,问答时材料全文和字幕、画面时间线一起放进缓存块。代码在 `apps/web/lib/video-materials/`、
`app/api/videos/[videoId]/materials/`。

- 格式:PDF(`unpdf`,只有文字层,扫描件会被拒)、docx、pptx、xlsx(JSZip 直接读 XML)、html/htm、
  md、txt、csv、tsv、json。老的 .doc/.ppt 不支持。单个 25 MB,每个视频 20 个、提取后总计 30 万字符。
- S3:`<owner>/<video>/materials.v1.json`(清单,S3 条件写防并发)、`materials/<id>/<文件名>`(原件)、
  `materials/<id>/text.txt`(提取文本)。下载一律走 `attachment` 签名 URL——上传的 HTML 绝不能在本域渲染。
- 问答历史按"视频 × 用户"存在 `<owner>/<video>/ask-history/<userId>.v1.json`,最多 60 条;
  每答完一次追加,打开 Ask 时载入,"Clear conversation" 删除。别人看不到你的对话。

## 实时字幕与翻译(Instant 模式录制)

**只对桌面端 Instant 模式的录制生效**(`desktopSegments` 源,录制中每 ~3 秒传一个音频分片)。
Studio 模式和上传的视频没有实时字幕,只有录完后的批量转写。

- **转写:** media-server 为每个录制开一路 Amazon Transcribe Streaming(`apps/media-server/src/lib/live-transcribe-stream.ts`)。
  分片按到达顺序灌进一个常驻 ffmpeg 解码成 16 kHz PCM;开启 partial results stabilization,
  Transcribe 标为 stable 的词一落到"已完整听完的分片"里就通过原有 webhook
  (`/api/webhooks/media-server/live-transcribe`)上报,web 写 `transcription.live.json`。
  实测:分片上传后约 4 秒出字,加上桌面端分片上传与页面 2.5 秒轮询,说话到看到字幕约 6–10 秒。
  语言在 `TRANSCRIBE_LANGUAGE_OPTIONS` 里自动识别(最多 5 种)。
- **翻译:** 分享页 Transcript 标签的实时字幕标题栏有语言下拉框,选了之后每条字幕下面显示译文,播放器字幕也切成译文。
  每条字幕用 Amazon Translate 只翻一次,按原文 hash 缓存在 `<owner>/<video>/transcription.live.<lang>.json`;
  同一进程内多名观众共享同一轮翻译。每次轮询最多翻 30 条新字幕,其余先显示原文。
- **录完以后:** 实时字幕**不会**直接升级成正式字幕(流式结果没有说话人,准确度也不如批量)。
  `promoteLiveTranscript` 直接排一次批量 Transcribe;批量完成前页面继续显示实时字幕,之后无缝换成正式字幕,
  之前选的语言会对正式字幕再请求一次翻译(走原有的 LLM 翻译)。
- **开关(CDK 给 cap-web 设的):** `LIVE_TRANSCRIBE_RUNNER=media-server`、`LIVE_TRANSCRIBE_ASR=aws-transcribe`、
  `LIVE_TRANSLATE_BACKEND=aws-translate`。去掉后两个就回到上游行为(没有 `ASSEMBLY_API_KEY` 时即无实时字幕)。
  IAM:任务角色加了 `transcribe:StartStreamTranscription`、`translate:TranslateText`、
  `comprehend:DetectDominantLanguage`(Translate 源语言为 auto 时用),这三个动作都没有资源类型,只能 `*`。
- **容错:** 流断了会从 web 记录的游标处重开一路流(分片在内存里缓存了最近 64 个),连续 3 次失败才放弃;
  没有新音频超过 5 秒会补 1 秒静音保活(Transcribe 15 秒收不到音频就断),补的静音会从时间轴上扣掉。
  单路会话上限 3 小时。
- **排查日志:** media-server 日志 `[live-transcribe] <id> stream restarting:`;web 日志
  `[liveTranscribe] <id> chunk a..b (… words) via media server`、`[liveTranslate] … failed`。
- **重新部署 media-server 可能打断正在进行的实时字幕**:旧任务 release 时 web 会先尝试把会话交给新的
  media-server 任务(从游标续上);新任务还没就绪就落到 workflow,而 workflow 没有 AssemblyAI key 会直接结束
  实时字幕。录制本身和录完后的批量转写不受影响。

## 已知的坑

**Service Connect 只认 deployment 创建时已存在的端点。** cap-web 调 media-server(`media-server:3456`),
media-server 回调 cap-web(`cap-web:3000`,处理进度和实时字幕的 webhook),两个方向都走 Service Connect。
一个 deployment 创建时命名空间里还没有的端点,它的任务永远解析不到——所以服务**同时新建**时总有一个方向不通,
而且不会自愈。CDK 让 cap-web 在 media-server 之后创建(保证 web → media),`deploy.sh` 首次部署结束时
再把两个服务各滚一次(保证反方向)。症状:桌面端录制全部 "Processing failed"(cap-web 日志
`Preverification skipped … fetch failed`),或 media-server 回调失败。处理:对受影响的服务
`aws ecs update-service --force-new-deployment`。新增服务间调用时也要记得这一点。

**Aurora 的 TLS 必须用 `?ssl=Amazon%20RDS`。** 写 `?ssl={"rejectUnauthorized":true}`
会失败并报 `unable to get local issuer certificate` / `HANDSHAKE_SSL_ERROR`——Aurora 的
证书由 Amazon RDS CA 签发，那个 CA 不在容器的信任库里。mysql2 内置了该 CA，用
`Amazon RDS` 这个 profile 名即可真正校验证书（比关掉校验好）。
`packages/database/index.ts` 只接受一个 URL 字符串，没有 options 入口，所以只能写在
query 里。

**ALB 健康检查必须接受 `200-399`。** cap-web 的 `/` 对未登录用户返回 307，只认 200
会让每个任务被判不健康、反复替换，而容器日志看起来完全正常。

**CloudFront VPC origin 必须按安全组引用放行。** 匹配 VPC CIDR 不管用，即使
CloudFront 的 ENI 确实在那个 CIDR 里。症状是目标 healthy、distribution 和 VPC origin
都 Deployed，却 504 三十秒。

**修改 `packages/env/server.ts` 里 `AI_PROVIDER` 的字面量 union 时，要同时改
`apps/web/lib/ai/provider.ts` 里的 `AiProviderId`。** 只改一处的症状是 env 校验拒绝该值，
报错指向配置而非代码。

**批处理转写的门控有十处,同步上游后要全部检查,而且上游还在不断加新的。** 上游把
`if (!serverEnv().ASSEMBLY_API_KEY)` 复制在每个会排转写的入口,我们统一改成了
`isTranscriptionConfigured()`(定义在 `apps/web/lib/whisper.ts`,含义是"有任一批处理
转写后端可用")。分别是:

- `apps/web/lib/transcribe.ts` — **入口**,漏了这处会让转写根本不进队列
- `apps/web/actions/videos/get-status.ts` — 注意这处是**正极性**判断
- `apps/web/app/s/[videoId]/page.tsx` — 分享页触发转写的条件
- `apps/web/workflows/transcribe.ts` ×2 — 两个 workflow 守卫
- `apps/web/lib/queue-video-transcription.ts`、`apps/web/lib/desktop-segments-finalization.ts`、
  `apps/web/workflows/finalize-desktop-recording.ts`、`apps/web/workflows/process-video.ts`、
  `apps/web/workflows/edit-video.ts` — 2026-11 同步时上游新增的五处,上传处理、桌面端分段、
  剪辑后重新转写各走一条;漏改的症状是**只有某一类录制**没字幕

判断标准:门控后面最终调用 `transcribeVideo()` 的就要改。`apps/web/lib/developer-transcript-speech.ts`
直接用 AssemblyAI SDK(开发者 API),**不要改**。

上游合并后用 `grep -rn "ASSEMBLY_API_KEY" apps/web packages` 复查(**不要只 grep
`workflows/transcribe.ts`** —— 实际踩过这个坑:入口那处在 `lib/` 而非 `workflows/`,
两个文件同名,只查一个就会漏)。

`apps/web/lib/live-transcribe.ts` 和 `apps/web/workflows/live-transcribe.ts` 里的
`ASSEMBLY_API_KEY` 判断**应当保留**:那是实时流式字幕,依赖 AssemblyAI 的 streaming
API,Whisper 批处理替代不了,该功能在本实例上不可用。

症状与排查:日志出现 `Failed to queue transcription` 或
`No transcription backend configured` 就是门控没改全。视频照样能上传播放,只是永远没字幕。

**"没出字幕"先确认素材有音轨。** 日志里
`Probe result: audioCodec=null` 表示这段录制根本没有声音,跳过是正确行为。
macOS 上最常见的原因是没给 Cap 麦克风权限,或者录制时没选中麦克风——两种情况都表现为
"看起来在录、但音轨为空"。

**不要在有人录制的时候重新部署 web 服务。** 转写 workflow 跑在 cap-web 的任务里,
`force-new-deployment` 会把它连同进行中的 workflow 一起回收。Whisper 是独立的 ECS 任务,
它照样会跑完并把词表写进 S3,但负责轮询结果、生成 VTT、写 `COMPLETE` 的那一步没了,于是:

- `transcriptionStatus` 永久停在 `PROCESSING`(没有任何服务端回收机制,
  `markError` 只在 workflow 的 catch 里执行)
- `audio-temp.mp3` 留在桶里(`cleanupTempAudio` 没跑),这是判断"卡在半路"最快的标志
- `whisper.words.json` 存在但没有 `transcription.vtt`

**恢复办法:让 owner 在分享页点 Retry Transcription**(或 POST
`/api/videos/<videoId>/retry-transcription`,它把状态置回 `null`,由 `get-status.ts` 自动重排)。
**重试几秒就完成,不会重跑推理** —— `transcribe.ts:809` 第一次轮询就会命中 S3 里已经存在的
`whisper.words.json`(会多起一个 whisper 任务,约 $0.02,可忽略)。

**Server Actions 必须把 CloudFront 域名加进 `allowedOrigins`。** 这是本部署形态最隐蔽的一个坑,
症状极具误导性:**页面能正常打开、数据也是对的,但任何客户端交互都不生效,手动刷新才会更新**。

原因是 CloudFront 的 `ALL_VIEWER_EXCEPT_HOST_HEADER` 会把 `Host` 换成 ALB 的内网 DNS 名,
并以 `x-forwarded-host` 转发;而 Next.js 对 Server Action 做 CSRF 校验时拿它和浏览器发来的
`Origin` 比对,不一致就整个拒绝:

```
`x-forwarded-host` header with value `internal-capsta-front-....elb.amazonaws.com`
does not match `origin` header with value `dxxxxxxxxxxxxx.cloudfront.net`
from a forwarded Server Actions request. Aborting the action.
⨯ Error: Invalid Server Actions request.
```

被打死的是**全部** Server Action:`getVideoStatus`(分享页每 2 秒的状态轮询)、
`getTranscript`、发评论、表情反应、改标题、各种设置。服务端渲染不受影响,所以看起来
"只是某个地方不刷新"。

`apps/web/next.config.mjs` 里的 `experimental.serverActions.allowedOrigins` 从
`NEXT_PUBLIC_WEB_URL` 推导,所以**换域名时不需要额外改动**,但必须记住这个值是构建期烧进
产物的(和 `NEXT_PUBLIC_WEB_URL` 本身一样),换域名要重建镜像。验证方法:

```bash
docker run --rm --entrypoint sh <image> -c \
  "node -e \"console.log(JSON.stringify(require('./apps/web/.next/required-server-files.json').config.experimental.serverActions))\""
```

排查时直接查日志关键字:`aws logs filter-log-events ... --filter-pattern '"Server Actions"'`。

**相关的待办:`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 目前没设。** Next 用它加密 action 闭包变量,
不设时每次构建/重启都会换一把新 key。单任务实例下影响有限(老页面上的 action 会失效,报
"Failed to find Server Action",刷新即可),但一旦把 web 服务扩到 2 个任务,同一用户的请求
落到不同任务上就会随机失败。扩容前要先把它做成 secret 注入。

**Bedrock 的 AWS SDK 不会自己走凭据链,必须显式传 `credentialProvider`。**
`@ai-sdk/amazon-bedrock` 只读 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 环境变量,或者
接收内联的 key —— 它**不**走 AWS 默认凭据链。ECS 的 task role 是从容器元数据端点
(`169.254.170.2`)下发的,不在环境变量里,所以不传就永远签不出名:

```
[ai] bedrock (...) failed for the "generation" role
Error: AWS SigV4 authentication requires AWS credentials.
Original error: AWS access key ID setting is missing.
→ AiUnavailableError: All AI providers failed → aiGenerationStatus = ERROR
```

`apps/web/lib/ai/provider.ts` 里传的是 `fromNodeProviderChain()`(环境变量、共享配置、
SSO、ECS 容器元数据、EC2 IMDS 全覆盖),并且做了记忆化 —— 凭据链自身带缓存和到期前刷新,
每次生成都新建一个会重复走链。仍然零静态密钥。

**注意这个坑用 `aws bedrock-runtime invoke-model` 是验不出来的** —— CLI 用的是你自己的
凭据,不是 task role,而且根本不经过这个 SDK。task role 的 `bedrock:InvokeModel` 权限本身
一直是对的。要验证只能让应用真的跑一次生成,或者看
`filter-log-events --filter-pattern '"[ai] bedrock"'`。

**新 Claude 模型在 Bedrock 上拒绝 `temperature`。** Sonnet 5.5 / Opus 5.5 收到它会返回
`ValidationException: \`temperature\` is deprecated for this model`。`apps/web/lib/ai/provider.ts` 的
`supportsTemperature()` 对 Bedrock 上的 Claude 一律返回 false;messenger 和转写翻译都靠这个开关决定传不传。
当前默认:总结 `us.anthropic.claude-sonnet-5-5`,问答聊天 `us.anthropic.claude-opus-5-5`。

**Bedrock 模型 id 要先核实存在。** 只列 inference profile 不够，`ACTIVE` 只说明 profile
存在、不代表账号有访问权。用真实调用验证：

```bash
aws bedrock-runtime invoke-model --model-id <id> --region us-east-1 \
  --content-type application/json \
  --body "$(printf '%s' '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"say ok"}]}' | base64 -w0)" /tmp/out.json
```

## 同步上游

```bash
git fetch upstream
git merge upstream/main
```

**上游 2026-11 起改用 Bun 1.4**(`bun.lock`,workspaces 写在根 `package.json`)。
`bun.lock` 冲突不要手改,取上游版本后重新解析:

```bash
git checkout --theirs bun.lock && git add bun.lock
bun install                     # 按合并后的 package.json 重新解析
```

根 `package.json` 的 `workspaces` 里要保留 `infra-aws`。`@ai-sdk/amazon-bedrock` 要钉在与上游
`ai` 共用同一个 `@ai-sdk/provider` 的版本(`bun.lock` 里查 `ai@` 的依赖),否则 `^` 会解析到最新版,
hoist 出第二套 provider 类型。

本地 `node_modules` 若还是 pnpm 时代留下的,`next typegen` 会报找不到
`node_modules/.pnpm/...`,`tsc` 报上百个假错误。删掉所有 `node_modules` 再 `bun install`。

`apps/web/package.json` 通常能自动合干净。合完确认三个包都在:
`@ai-sdk/amazon-bedrock`、`@aws-sdk/client-ecs`(我们的)以及上游新加的。

**合并后必查的不变量**(这些是自建能用的前提):

- `packages/utils/src/constants/plans.ts` 里 `if (!buildEnv.NEXT_PUBLIC_IS_CAP) return true`
- 十处 `isTranscriptionConfigured()` 门控(见上一节)
- 登录不再需要 fork 改动:上游的 OIDC provider 读 `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`。
  上游若改了这三个变量名或回调路径 `/api/auth/callback/oidc`,要同步改 `infra-aws/lib/compute.ts` 和 `auth.ts`
- `apps/web/lib/ai/provider.ts` 里的 `bedrock` 分支

**`__tests__/unit/slack-app-manifest.test.ts` 有一条测试恒定失败**,上游自带:
测试写死 `#4785FF`,`apps/web/slack-app-manifest.json` 里是 `#1e60e6`。不是我们
引入的,也不影响任何功能(Slack 集成在本实例不可用)。看到它失败不要去查自己的改动。

### 上游的迁移会在下次部署时自动执行

`apps/web/instrumentation.node.ts:15` 在 `NEXT_PUBLIC_IS_CAP` 未设置时跑 drizzle
迁移——也就是**我们这种部署一定会跑**。重试 3 次后 `process.exit(1)`,容器死掉、
ECS 反复替换,症状是部署迟迟不 `COMPLETED`。

因此同步上游后要先看新增的 `packages/database/migrations/*.sql` 是否有破坏性语句
(`DROP`、`MODIFY COLUMN ... NOT NULL` 之类)。纯 `CREATE TABLE` 可以放心。
Aurora 保留 7 天备份,真出事可以按时间点恢复。

## 拆除

`RemovalPolicy` 是 `RETAIN`（S3、ECR）和 `SNAPSHOT`（Aurora），所以 `cdk destroy`
**不会**删掉它们。这是刻意的（保护数据），但意味着拆除后要手工清理，否则会继续
产生存储费用。CREATE 失败回滚也一样会留下这些孤儿资源。

## 已知功能缺失

均为设计文档 §2 明确列出的非目标，不是缺陷：

- **邮件全部不发**。`packages/database/emails/config.ts` 写死 Resend，缺 key 时静默
  `return`。评论通知、分享通知、团队邀请都不会发出，也不会报错
- 音频增强不可用（依赖第三方 Replicate）
- 无自定义域名，用 CloudFront 默认域名
- Cap 的手机 App 连到本实例找不到可用登录方式——它读自己的配置结构，只认
  apple/google/workos
- 用户自配的 S3 桶里的视频不会走 Whisper 转写（Whisper 任务的 IAM 只能访问我们的桶）
