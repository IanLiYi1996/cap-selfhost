# Cap 自建部署到 AWS — 设计文档

- **日期**：2026-08-17
- **状态**：已确认，待转实施计划
- **仓库**：`IanLiYi1996/cap`（`CapSoftware/Cap` 的私有镜像），工作分支 `dev`
- **上游基点**：`7bd58e1e4`

## 1. 背景与目标

在我们自己的 AWS 账号（内部账号，受 AppSec 基线约束）上部署一套自建的 Cap，供公司同事录制、分享屏幕录像。桌面端指向这个实例。

选择自建而非 Cap Cloud 的直接动因：Cap Cloud 把「连接自有 S3 桶」列为 Pro 付费功能，而自建实例上 `userIsPro()` 恒为 `true`（`packages/utils/src/constants/plans.ts:25`，因为 `NEXT_PUBLIC_IS_CAP` 未设置），Pro 门槛自然消失。这是上游在代码里留出的行为，不是绕过。

成功标准：

1. 同事能用 Cognito 账号登录 Web 端，在 VPN 外也能打开分享链接
2. 浏览器和桌面端都能录制、上传、播放
3. 视频有自动字幕（Whisper）和 AI 摘要/章节（Bedrock）
4. S3 桶零公开策略，计算层无公网入站，无长期 access key

## 2. 非目标

- 不做多租户、不做计费（Stripe 相关 env 全部留空）
- 不做音频增强（依赖第三方 Replicate，`apps/web/lib/audio-enhance.ts:15` 有 config 检查，不配即优雅跳过）
- 不做邮件通知。`sendEmail` 写死 Resend（`packages/database/emails/config.ts:3`），且在缺少 `RESEND_API_KEY` 时**静默 no-op**（同文件第 32 行直接 `return Promise.resolve()`）。因此评论通知、分享通知、团队邀请邮件都不会发出，也不会报错。**这是已知的功能缺失，不是 bug**，后续若需要可单独接 SES（`sendEmail` 是唯一入口，接缝干净）
- 不做自定义域名。一期用 CloudFront 默认 `*.cloudfront.net` 域名
- 不改上游的 `infra/sst.config.ts`
- 不启用 GitHub Actions（仓库已禁用，见 §14）

## 3. 关键约束

| 约束 | 来源 | 影响 |
| --- | --- | --- |
| S3 不得公开 | 内部账号 AppSec 基线 | 桶 `BLOCK_ALL`，OAC + 签名 URL |
| 不得有 `Principal: "*"` 资源策略 | 同上 | OAC 桶策略带 `SourceArn` 条件 |
| 数据库不得公网可达 | 同上 | Aurora 私有子网，`publiclyAccessible: false` |
| 避免长期静态凭据 | 同上 | Task Role，不设 `CAP_AWS_ACCESS_KEY` |
| 分享链接需 VPN 外可达 | 使用场景 | internet-facing 入口（仅 443） |
| 上游会持续演进 | AGPL 项目，需长期同步 | 新增代码尽量放新目录，减少 merge 冲突 |

## 4. 架构总览

```
                    ┌─────────────────────────┐
   浏览器 / 桌面端 ──┤ CloudFront (App)        │  *.cloudfront.net
                    │   VPC origin            │
                    └───────────┬─────────────┘
                                │ (AWS 骨干，不经公网)
                    ┌───────────▼─────────────┐
                    │ 私有 ALB                │
                    └───────────┬─────────────┘
   ┌────────────────────────────┼────────────────────────────┐
   │ 私有子网 ×2 AZ             │                            │
   │              ┌─────────────▼──────────┐                 │
   │              │ ECS: cap-web           │                 │
   │              │ 1 vCPU / 2 GB          │                 │
   │              └──┬──────────┬──────────┘                 │
   │                 │          │ Service Connect            │
   │    ┌────────────▼───┐  ┌───▼──────────────┐             │
   │    │ Aurora SLS v2  │  │ ECS: media-server│             │
   │    │ MySQL 8.0      │  │ 2 vCPU / 4 GB    │             │
   │    └────────────────┘  └──────────────────┘             │
   │                                                          │
   │              ┌──────────────────────────┐               │
   │              │ ECS RunTask: whisper     │  按需，跑完退出 │
   │              │ 4 vCPU / 8 GB            │               │
   │              └──────────────────────────┘               │
   └──────────────────────────┬───────────────────────────────┘
                              │ S3 Gateway Endpoint
                    ┌─────────▼───────────┐      ┌──────────────────┐
                    │ S3 (BLOCK_ALL)      │◄─OAC─┤ CloudFront (Media)│
                    └─────────────────────┘      └──────────────────┘
                              ▲                            │
                              │ 预签名 PUT 直传             │ 签名 URL 播放
                              └────── 浏览器/桌面端 ────────┘
```

三条独立的数据通路，容易混淆，明确记录：

1. **应用访问**：客户端 → CloudFront(App) → VPC origin → 私有 ALB → cap-web
2. **上传**：客户端拿 S3 预签名 PUT/POST，**直连 `bucket.s3.amazonaws.com`**，不经过我们的计算层。端点公网可达但请求必须带 SigV4 签名，桶依然零公开
3. **播放**：客户端拿 CloudFront 签名 URL → CloudFront(Media) → OAC → S3

第 2、3 条走不同路径是上游代码决定的，不是我们的选择：`cloudfrontBucketAccess` 只覆盖 `getSignedObjectUrl`（`packages/web-backend/src/S3Buckets/index.ts:122` 起），写路径仍用 S3 直连预签名。

## 5. 网络与入口

- VPC，2 AZ，`10.0.0.0/16`
- 公有子网 ×2：仅放 NAT Gateway
- 私有子网 ×2：ALB、Fargate 任务、Aurora
- **单个** NAT Gateway（非每 AZ 一个）。理由：出站流量只有拉镜像和调 Cognito/Bedrock 端点，AZ 级冗余不值 $32/月
- **S3 Gateway Endpoint**（免费）——这是必需项不是优化，视频字节量大，走 NAT 的数据处理费会很难看

入口用 **CloudFront VPC origin 直连私有 ALB**。这样 ALB 没有公网 IP、不需要公有子网入站，CloudFront 到 ALB 的流量走 AWS 骨干。

之所以必须有 CloudFront 而不能直接暴露 ALB：没有自定义域名就拿不到 ACM 证书，ALB 无法提供 HTTPS。CloudFront 默认域名自带受信任证书，这是零域名成本获得 HTTPS 的唯一途径。桌面端和 Cognito 回调都需要固定的 HTTPS 地址。

**退路**：若 VPC origin 撞上限制（如不支持某项 ALB 配置），改为 internet-facing ALB + SG 只放行 CloudFront 托管前缀列表 `com.amazonaws.global.cloudfront.origin-facing` + 校验 CloudFront 注入的自定义 header。这是经典做法，不影响设计其他部分。

两个 CloudFront distribution，都用默认域名：

| Distribution | Origin | 用途 |
| --- | --- | --- |
| App | VPC origin → 私有 ALB | Next.js 应用 |
| Media | OAC → S3 | 视频播放，签名 URL |

**为什么分两个而不是一个多 behavior**：Cap 期望 `CAP_AWS_BUCKET_URL` 是能直接拼 key 的根地址（代码里是 `${bucketUrl}/${key}`）。用 path behavior 会引入前缀剥离问题，需要额外的 CloudFront Function 改写。上游生产环境也是分开的——`infra/sst.config.ts` 的 CORS 白名单里 `cap.so` 和 `dyk2p776s2gx5.cloudfront.net` 是两个不同的 host。

## 6. 存储与分发

S3 桶配置：

- `blockPublicAccess: BLOCK_ALL`
- SSE-S3 加密（不用 KMS，YAGNI；如合规要求 CMK 再改）
- 不开版本控制（视频文件，改动少体积大）
- CORS：`allowedOrigins` 填 App distribution 域名，`allowedMethods` = GET / POST / PUT。**这是 CORS 配置，不是公开策略**，因为客户端要直传预签名 URL
- 桶策略：仅 OAC 一条，带 `AWS:SourceArn` 条件限定 Media distribution

CloudFront Media distribution：

- OAC 访问 S3
- 签名 URL（trusted key group）。公钥由 CDK 创建，**私钥手工放入 Secrets Manager**——密钥对必须配对，这一步无法自动化
- 对应 env：`CAP_AWS_BUCKET_URL`（= distribution 域名）、`CAP_CLOUDFRONT_DISTRIBUTION_ID`、`CLOUDFRONT_KEYPAIR_ID`、`CLOUDFRONT_KEYPAIR_PRIVATE_KEY`

**`S3_PATH_STYLE` 必须显式设为 `false`**。`packages/env/server.ts` 里这个值默认 `true`（为 MinIO 准备的），真正的 AWS S3 需要 virtual-hosted style。

## 7. 计算与数据库

ECS 集群，两个常驻 Fargate 服务，均在私有子网：

| 服务 | 规格 | 健康检查 | 说明 |
| --- | --- | --- | --- |
| cap-web | 1 vCPU / 2 GB | `GET /` | Next.js |
| media-server | 2 vCPU / 4 GB | `GET /health` | ffmpeg 转码、音频提取 |

**media-server 不可省略**。`apps/web/workflows/process-video.ts:81` 在 `MEDIA_SERVER_URL` 缺失时直接 `throw new FatalError`，视频处理流程硬依赖它。它只暴露 `/health`、`/audio`、`/video`（`apps/media-server/src/app.ts`），是纯 server-to-server 服务，浏览器和桌面端都不需要访问，因此不挂 ALB，仅通过 Service Connect 暴露。

Service Connect 命名空间 `cap.local`，使 `MEDIA_SERVER_URL=http://media-server:3456` 与仓库 `docker-compose.yml` 里的形状保持一致，降低认知负担。

镜像来源：

- cap-web：上游 `ghcr.io/capsoftware/cap-web` **mirror 到 ECR**。内部账号通常封禁 ghcr 直连
- media-server：上游无预构建镜像，用 `apps/media-server/Dockerfile.standalone` 自行构建推 ECR
- whisper：新建，见 §9

IAM：

- **Task Role**：桶上 `s3:GetObject/PutObject/DeleteObject/AbortMultipartUpload` + `s3:ListBucket`、`cloudfront:CreateInvalidation`、指定 secret 的 `secretsmanager:GetSecretValue`、`bedrock:InvokeModel`、`ecs:RunTask` + `iam:PassRole`（起 whisper 任务用）
- **Execution Role**：ECR pull + CloudWatch Logs
- **不设 `CAP_AWS_ACCESS_KEY` / `CAP_AWS_SECRET_KEY`**，让 `packages/web-backend/src/Aws.ts:44` 落到 `fromContainerMetadata()`，即 Task Role

数据库：Aurora Serverless v2 MySQL 8.0，0.5–4 ACU，私有子网，`publiclyAccessible: false`，SG 仅放行 Fargate SG 的 3306，备份保留 7 天，凭据由 Secrets Manager 自动生成。

**TLS 有个具体约束**：`packages/database/index.ts:13` 是 `drizzle(url)`，只接受一个 URL 字符串，没有 options 入口。因此开启 `require_secure_transport=ON` 后，TLS 参数只能塞进连接串：

```
mysql://<user>:<pass>@<host>:3306/cap?ssl={"rejectUnauthorized":true}
```

`DATABASE_URL` 由 CDK 从 Aurora secret 拼装后写入 Secrets Manager，容器启动时注入。

## 8. 身份认证（Cognito）

新建独立 user pool（不复用公司现有 pool）：

- 邮箱登录 + 自验证
- 验证码邮件用 **Cognito 自带发信**（每日 50 封限额，小团队足够）。这样连 SES 沙箱那道坎都绕开了，邮件缺失只影响 §2 列出的通知类功能
- App client 带 secret，authorization code flow，scopes `openid email profile`
- 回调 URL：`https://<app-dist>.cloudfront.net/api/auth/callback/cognito`
- Hosted UI 用 Cognito 前缀域名

**无循环依赖**：CDK 在同一个 stack 内把 App distribution 的 `domainName` 传给 user pool client 的回调 URL。CloudFront 不依赖 Cognito，方向是单向的。

Web 端接入是三处小改动，照现有 Apple provider 的写法（条件式加入，不学 Google/WorkOS 那种 `as string` 硬塞）：

| 文件 | 改动 |
| --- | --- |
| `packages/env/server.ts` | 加 `COGNITO_CLIENT_ID` / `COGNITO_CLIENT_SECRET` / `COGNITO_ISSUER`，均 optional |
| `packages/database/auth/auth-options.ts` | 在第 71 行的 providers 数组里条件式加 `CognitoProvider` |
| `apps/web/app/(org)/login/form.tsx` | 加 `handleCognitoSignIn` + 按钮，照 `handleGoogleSignIn` |

`COGNITO_ISSUER` 形如 `https://cognito-idp.us-east-1.amazonaws.com/<poolId>`。

**桌面端零改动**。`apps/desktop/src/utils/auth.ts:63` 走 `/api/desktop/session/request`，只要 Web 侧存在有效会话就能换取 api_key，对使用哪个 provider 完全无感。桌面端通过 `Settings > Cap Server URL` 或构建期的 `VITE_SERVER_URL`（`apps/desktop/src-tauri/src/web_api.rs:65` 的 `option_env!`）指向本实例。

## 9. AI 能力

### 9.1 依赖链决定了实施顺序

```
Whisper STT → transcription.vtt → Bedrock LLM（标题 / 摘要 / 章节 / 字幕翻译）
```

`apps/web/workflows/generate-ai.ts:138` 在 `transcriptionStatus !== "COMPLETE"` 时直接 `throw new FatalError("Transcription not complete")`，并从桶里读 `${userId}/${videoId}/transcription.vtt`。**没有转写，LLM 功能全部空转**，因此 STT 必须先于 LLM 落地。

另外两个不依赖 transcript 的 LLM 入口对本实例无用：`apps/web/app/api/docs/ask/route.ts` 是 cap.so 文档站的问答，`apps/web/lib/messenger/agent.ts` 在 `apps/web/actions/messenger.ts:33` 有 `NEXT_PUBLIC_IS_CAP !== "true"` 检查，自建实例上根本不启用。

**好消息**：转写失败是隔离的。`apps/web/workflows/process-video.ts:489-505` 把整个转写调用包在 try/catch 里，只 `console.warn`。所以 AI 出问题不会影响录制、上传、播放、分享、评论。

### 9.2 STT：Whisper 替换 AssemblyAI

上游把 AssemblyAI 写死了——`apps/web/workflows/transcribe.ts:770` 和 `:818` 直接 `new AssemblyAI({ apiKey })`，缺 key 就 `FatalError`，没有 provider 抽象。

**但接缝比表面看起来干净得多**。`apps/web/lib/edit-transcript.ts:129` 的 `createEditTranscript(result, durationMs)` 只读 `result.words[]`，字段要求如下：

| 字段 | 必需性 |
| --- | --- |
| `text` | **必需** |
| `start` / `end` | **必需**，单位毫秒 |
| `confidence` | 可选，`null` 合法 |
| `speaker` | 可选，`nullableString` |
| `channel` | 可选 |

**说话人分离不是必需的**——这砍掉了 Whisper 方案最大的一块工作量，不需要叠 pyannote / WhisperX。

因此改造方式是：新增 `transcribeWithWhisper(...)`，返回与 `transcribeWithAssemblyAI` 相同的 `TranscriptionArtifacts { vtt, editTranscript }`，内部把 Whisper 的词表映射成上述形状后交给现有的 `createEditTranscript` → `editTranscriptWordsToCaptionVtt` → `serializeEditTranscript`，这三个函数原样复用。`transcribeEditTranscriptWithAssemblyAI` 同样处理。

**必须记住的坑**：AssemblyAI 的 `start`/`end` 是**毫秒**，Whisper 是**秒**。映射时要 ×1000，漏了时间轴会错三个数量级。

选 Whisper 而非 Amazon Transcribe 的理由：

- **中文识别明显更好**，这是决定性因素
- 零按量成本（Amazon Transcribe 约 $1.44/小时音频）
- 音频不出账号

代价是 CPU 上比 Transcribe 慢（`medium` int8 约 2–3 倍实时，10 分钟视频约 3–5 分钟），且要自己养推理服务。因为转写是异步的持久化步骤（`"use step"`），延迟可接受。

### 9.3 Whisper 服务形态

新建 **`apps/whisper-server/`**（Python + `faster-whisper`），用 **ECS RunTask 按需起一次性任务**，处理完退出。

- 开 `word_timestamps=True`，正好产出 `{word, start, end, probability}`
- 模型 `medium` int8（中文质量与速度的平衡点），权重烧进镜像或启动时从 S3 拉
- 任务规格 4 vCPU / 8 GB
- 输入输出都走 S3：任务从 S3 读音频（`${userId}/${videoId}/${tempAudioFilename}`，上游已经放在那里），把词表 JSON 写回 S3；`cap-web` 的 workflow step 轮询结果
- 成本约 **$0.02 / 10 分钟视频**，相比常驻 Fargate 的 $142/月几乎可忽略

**放新目录而非塞进 media-server，有一条架构之外的理由**：新目录上游永远不会碰，merge 零冲突。改 media-server 就要在上游持续演进的代码里塞 whisper.cpp 编译和模型权重，每次同步都要重新处理。这与 §10 把 CDK 放 `infra-aws/` 是同一个判断。

代价是多一层「起任务 + 等结果」的编排，但 `"use step"` 的持久化步骤天生适合这个模式——步骤可长跑、可重试、失败不丢状态。

### 9.4 LLM：Bedrock

`apps/web/lib/ai/provider.ts` 是 Vercel AI SDK + provider registry，结构清晰。装 `@ai-sdk/amazon-bedrock`，改动五处：

1. `AiProviderId` union 加 `"bedrock"`
2. `DEFAULT_MODELS` 加 bedrock 的三个 role（generation / chat / chat-streaming）
3. `isUsable` 的 switch 加分支
4. `createModel` 的 switch 加 `case "bedrock"`
5. fallback 链数组（`generation` / `chat` / `chat-streaming`）加入 bedrock

**注意 `AI_PROVIDER` 的字面量 union 存在于两处**，只改一处会导致 env 校验拒绝 `AI_PROVIDER=bedrock`：除上面第 1 条的 `apps/web/lib/ai/provider.ts`，还有 `packages/env/server.ts:96` 的 zod union，同样要加 `z.literal("bedrock")`。

走 Task Role 的 `bedrock:InvokeModel`，**零静态密钥**。这比 `AI_PROVIDER=openai-compatible` 指向 Bedrock 的 OpenAI 兼容端点更好——后者虽然零代码改动，但要多一个静态 API key 进 Secrets Manager，且兼容层的特性支持有限。

### 9.5 明确不做

音频增强（`REPLICATE_API_TOKEN`，第三方 Replicate）。`apps/web/lib/audio-enhance.ts:15` 有明确的 config 检查，不配即跳过。

## 10. 代码改动清单

### 10.1 新增目录（上游永不冲突）

| 目录 | 内容 |
| --- | --- |
| `infra-aws/` | CDK app（TypeScript） |
| `apps/whisper-server/` | Python + faster-whisper 服务 |

**CDK 不放进现有 `infra/`**：那份 `sst.config.ts` 深度绑定 Cap 自己的 Vercel team ID、PlanetScale、Cloudflare 账号，以及硬编码的 distribution ID（`E36XSZEM0VIIYB`）和 IAM user，扩展它会和上游 merge 持续冲突。

### 10.2 修改现有文件（尽量小、尽量局部）

| 文件 | 改动 | 冲突风险 |
| --- | --- | --- |
| `packages/env/server.ts` | 加 Cognito ×3、Whisper ×2、Bedrock 相关 env | 低（纯追加） |
| `packages/database/auth/auth-options.ts` | providers 数组加 `CognitoProvider` | 低 |
| `apps/web/app/(org)/login/form.tsx` | 加 handler + 按钮 | 中（UI 文件上游改动频繁） |
| `apps/web/lib/ai/provider.ts` | 五处加 bedrock | 中 |
| `apps/web/workflows/transcribe.ts` | 加 Whisper 路径，保留 AssemblyAI 分支 | **高**（上游活跃文件） |

`transcribe.ts` 是冲突风险最高的一处。缓解策略：**保留原有 AssemblyAI 分支不删**，按 env 选择路径（`ASSEMBLY_API_KEY` 存在走原路，`WHISPER_*` 存在走新路），并把 Whisper 的映射逻辑放进新文件 `apps/web/lib/whisper.ts`，让 `transcribe.ts` 里的改动尽量薄。这样上游改动这个文件时冲突面最小。

## 11. 密钥管理

全部进 Secrets Manager，容器通过 task definition 的 `secrets` 注入（不走环境变量明文）：

| Secret | 来源 |
| --- | --- |
| `NEXTAUTH_SECRET` | CDK 生成随机值 |
| `DATABASE_ENCRYPTION_KEY` | CDK 生成随机值 |
| `MEDIA_SERVER_WEBHOOK_SECRET` | CDK 生成随机值 |
| `DATABASE_URL` | 从 Aurora secret 拼装 |
| `COGNITO_CLIENT_SECRET` | Cognito app client 输出 |
| `CLOUDFRONT_KEYPAIR_PRIVATE_KEY` | **手工放入**（需与 CDK 创建的公钥配对） |

`DATABASE_ENCRYPTION_KEY` 需特别注意：用户自定义 S3 凭据是用它加密后存库的（`apps/web/app/api/desktop/[...route]/s3Config.ts` 的 `encrypt`/`decrypt`），**一旦上线有数据就不能再改**。

`docker-compose.yml` 里那些硬编码的示例值（`0123456789abcdef...`、`abcdef0123456789...`）**绝对不能带到生产**。

## 12. 关键环境变量

与 `docker-compose.yml` 默认值不同、容易配错的部分：

```
# 存储
CAP_AWS_BUCKET=<bucket>
CAP_AWS_REGION=us-east-1
S3_PATH_STYLE=false                      # 默认 true 是给 MinIO 的
# CAP_AWS_ACCESS_KEY / CAP_AWS_SECRET_KEY 刻意不设 → 走 Task Role
# S3_PUBLIC_ENDPOINT 不设 → 上传签标准 S3 URL

# 播放分发
CAP_AWS_BUCKET_URL=https://<media-dist>.cloudfront.net
CAP_CLOUDFRONT_DISTRIBUTION_ID=<id>
CLOUDFRONT_KEYPAIR_ID=<id>

# 应用
WEB_URL=https://<app-dist>.cloudfront.net
NEXTAUTH_URL=https://<app-dist>.cloudfront.net
MEDIA_SERVER_URL=http://media-server:3456
MEDIA_SERVER_WEBHOOK_URL=http://cap-web:3000

# 认证
COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/<poolId>
COGNITO_CLIENT_ID=<id>

# AI
AI_PROVIDER=bedrock
AI_MODEL=<bedrock model id>
WHISPER_TASK_DEFINITION_ARN=<arn>
WHISPER_CLUSTER_ARN=<arn>

# 刻意留空：RESEND_API_KEY、ASSEMBLY_API_KEY、REPLICATE_API_TOKEN、
#          STRIPE_*、NEXT_PUBLIC_IS_CAP
```

`NEXT_PUBLIC_IS_CAP` **必须保持未设置** —— 这是自建实例解锁 Pro 功能的开关（`packages/utils/src/constants/plans.ts:25`）。

## 13. 测试策略

**CDK 安全属性断言**（`aws-cdk-lib/assertions`）。这些直接对应 §3 的合规约束，是本项目最有价值的自动化测试：

- S3 桶 `BlockPublicAcls` / `BlockPublicPolicy` / `IgnorePublicAcls` / `RestrictPublicBuckets` 全为 true
- 桶策略中无 `Principal: "*"`，OAC 策略带 `AWS:SourceArn` 条件
- Aurora `PubliclyAccessible: false`
- 无 SG 规则在非 web 端口开放 `0.0.0.0/0`
- Task definition 中不含明文凭据

**单元测试**（仓库现有 vitest，`apps/web/__tests__/unit/`）：

- `authOptions()` 在 Cognito env 存在 / 缺失两种情况下的 providers 数组
- Whisper 词表 → `createEditTranscript` 输入的映射，**重点覆盖秒→毫秒换算**和边界（空词表、`end <= start`、缺失 confidence）
- `provider.ts` 的 bedrock 分支在 `isUsable` / fallback 链中的行为

**部署后手工验证清单**：

1. Cognito 登录成功，session 建立
2. 浏览器录制 → 上传 → 播放，确认播放 URL 指向 Media distribution 且带签名参数
3. 确认桶无公开访问（`aws s3api get-public-access-block` + 匿名 curl 应 403）
4. 转写完成，`transcription.vtt` 落到桶里，字幕可显示，中文准确度抽检
5. AI 摘要 / 章节生成
6. 桌面端设置 Cap Server URL → 登录 → 录制 → 上传 → 分享链接在 VPN 外可打开

## 14. 实施阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 | CDK 基础：VPC、ECR + 镜像 mirror、Aurora、S3、CloudFront ×2、Secrets、安全断言测试 | `cdk deploy` 通过，断言测试绿 |
| 2 | ECS 两个服务 + Service Connect + 健康检查 | 能访问到登录页 |
| 3 | Cognito pool + 三处代码改动 | 同事能登录 |
| 4 | 桌面端对接 + 端到端验证（录制/上传/播放/分享） | 手工清单 1–3、6 通过 |
| 5 | `apps/whisper-server` + RunTask 编排 + `transcribe.ts` 改造 | 字幕生成，清单 4 通过 |
| 6 | Bedrock provider | AI 摘要/章节，清单 5 通过 |

阶段 1–4 交付一个**可用**的 Cap（录制、分享、协作齐全，只缺 AI）。5–6 补 AI。这个切分让最大的风险（网络与入口）最早暴露，也让 AI 那部分改动能在一个已知可用的基线上验证。

## 15. 风险与未决问题

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| CloudFront VPC origin 撞上 ALB 配置限制 | 阶段 2 阻塞 | 退路见 §5 |
| `transcribe.ts` 上游冲突 | 长期维护成本 | 保留原分支 + 逻辑外移到新文件（§10.2） |
| Whisper `medium` int8 中文质量不达预期 | 字幕可用性 | 可切 `large-v3`（需更大任务规格或转 SageMaker GPU） |
| RunTask 冷启动 + 拉镜像耗时 | 转写延迟 | 权重烧进镜像避免运行时下载；接受分钟级延迟 |
| Bedrock 模型在 us-east-1 的可用性与配额 | 阶段 6 | 部署前确认模型访问已开通 |
| 邮件通知缺失 | 功能缺失（已知） | §2 已记录，后续可接 SES |

未决项的结论（实施完成后回填）：

**Bedrock 模型选型 — 已定。** 不通过 `AI_MODEL` / `AI_CHAT_MODEL` 配置，而是钉在
`apps/web/lib/ai/provider.ts` 的 `DEFAULT_MODELS.bedrock` 里，并有测试断言精确值：

- generation：`us.anthropic.claude-haiku-4-5-20251001-v1:0`
- chat / chat-streaming：`us.anthropic.claude-sonnet-4-6`

两者都用真实 `invoke-model` 调用验证过可用。注意本文档原先写的
`us.anthropic.claude-sonnet-5-20250929-v1:0` **不存在**，是把版本号和无关日期拼错了；
只列 inference profile 不足以发现这点，因为 `ACTIVE` 只说明 profile 存在、不代表账号有
访问权。`AI_MODEL` / `AI_CHAT_MODEL` 环境变量仍可用作临时覆盖。

**KMS CMK vs SSE-S3 — 保持 SSE-S3。** 这是个人账号，没有提出需要客户托管密钥的合规基线，
而 SSE-S3 已满足静态加密。触发改动的条件：出现明确要求 CMK 的合规要求，或需要按密钥做
访问审计。代价是每个密钥约 $1/月加按请求计费，且轮换与跨账号授权都要自己管。

**视频生命周期策略 — 暂不设置，给出触发条件。** 当前用量下（个人/小团队）加生命周期规则
是过早优化。建议在**桶超过 100 GB** 时再动手，届时的合理默认是 90 天后转
Infrequent Access（约省 45% 存储费），而不要转 Glacier——分享链接需要即时可读，Glacier
的取回延迟会直接破坏产品体验。查用量：
`aws s3 ls s3://<bucket> --recursive --summarize | tail -2`

## 16. 代码依据索引

本文档的判断均来自上游代码，便于后续核对与上游演进时复查：

| 结论 | 位置 |
| --- | --- |
| 自建实例全员 Pro | `packages/utils/src/constants/plans.ts:25` |
| Pro 门槛在客户端 UI | `apps/desktop/src/routes/(window-chrome)/settings/integrations/index.tsx:105` |
| 对象访问全部预签名 | `packages/web-backend/src/S3Buckets/S3BucketAccess.ts:169,338,411` |
| CloudFront 签名 URL 支持 | `packages/web-backend/src/S3Buckets/index.ts:122` |
| 凭据 fallback 到 Task Role | `packages/web-backend/src/Aws.ts:44` |
| `drizzle(url)` 无 options 入口 | `packages/database/index.ts:13` |
| Resend 写死 + 静默 no-op | `packages/database/emails/config.ts:3,32` |
| media-server 硬依赖 | `apps/web/workflows/process-video.ts:81` |
| 转写失败被隔离 | `apps/web/workflows/process-video.ts:489-505` |
| AI 生成硬依赖 transcript | `apps/web/workflows/generate-ai.ts:138` |
| AssemblyAI 写死 | `apps/web/workflows/transcribe.ts:770,818` |
| 词表契约（三字段必需） | `apps/web/lib/edit-transcript.ts:129` |
| LLM provider registry | `apps/web/lib/ai/provider.ts:212` |
| 桌面端 provider 无感 | `apps/desktop/src/utils/auth.ts:63` |
| 桌面端服务器地址编译期注入 | `apps/desktop/src-tauri/src/web_api.rs:65` |
| 上游自己的 AWS 形态 | `infra/sst.config.ts` |
