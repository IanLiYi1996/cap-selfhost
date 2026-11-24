# 部署到你自己的 AWS 账号

这份指南把这个仓库(Cap 的自建分支)部署到**你自己的** AWS 账号里。部署完你会得到一个只有登录用户能用的
Cap 实例:录屏上传、播放、分享,Amazon Transcribe 自动转写字幕,Claude 生成总结和章节,以及基于视频内容的问答。

日常运维、踩过的坑和设计理由见 [`design/notes/aws-deployment-runbook.md`](../design/notes/aws-deployment-runbook.md)
(那份是写给已经部署好的实例的,命令里的 ID 是原作者账号的,不要照抄)。

## 一、前提

**账号与区域**

- 一个你有管理员权限的 AWS 账号,区域固定为 **us-east-1**(写在 `lib/config.ts`;Bedrock 模型 ID 用的是
  `us.` 前缀的跨区推理配置,换区域需要改代码)。
- 在 Bedrock 控制台的 **Model access** 里开通 **Claude Sonnet 5.5** 和 **Claude Opus 5.5**。没开通时视频照常可用,
  只是总结和问答会失败;部署脚本会先检查并提醒。

**一台构建机**(Linux 或 macOS 都行,镜像统一构建成 x86_64)

- Docker(在运行中)、Node 24+、[Bun](https://bun.sh) 1.4、AWS CLI v2、`openssl`、`python3`、`jq`、`curl`
- 约 20 GB 空闲磁盘(Whisper 镜像约 2.6 GB,构建缓存更大)
- AWS 凭证已配置好(`aws sts get-caller-identity` 能返回你的账号)

**费用**(粗略估算,以账单为准)

- 固定开销约 **$200/月起**:NAT 网关、Aurora Serverless v2 最小容量、两个常驻 Fargate 服务(web、media-server)、
  内部负载均衡,外加少量 CloudFront / S3 / Secrets Manager。
- 按用量:Amazon Transcribe 约 $1.44/小时音频;Bedrock(总结用 Sonnet 5.5,问答用 Opus 5.5,画面理解用 Sonnet 5.5)。

**许可证**:Cap 主体是 AGPLv3。公司内部使用没有问题;如果给公司以外的人用,需要向他们提供修改后的源代码。

## 二、一条命令部署

```bash
git clone <这个仓库> cap && cd cap
git checkout dev
./infra-aws/scripts/deploy.sh --admin-email you@example.com
```

脚本会依次完成(每一步都先检查,已经做过的会跳过,所以**中途失败了直接重跑即可**):

1. 检查工具、凭证和 Bedrock 模型访问权限
2. 生成 CloudFront 签名密钥(视频地址的签名用),存在 `~/.cap-deploy/<账号ID>/`
3. 安装依赖;账号还没用过 CDK 时执行 `cdk bootstrap`
4. **首次部署**:先以 0 个任务建出整套资源(镜像要用到站点地址,而地址要部署后才有)
5. 查出 CloudFront 为 VPC origin 自动创建的安全组
6. 填写 CDK 无法自动填的两个 secret:CloudFront 私钥、数据库连接串
7. 用你自己的站点地址构建并推送 web、media-server、Whisper 三个镜像
8. 正式部署,等服务稳定
9. 在 Cognito 里创建 `--admin-email` 这个用户,并**打印一次**它的密码

首次部署大约需要 1 小时,大部分时间花在创建 CloudFront / Aurora 和第一次构建镜像上。完成后会打印站点地址
(形如 `https://dxxxxxxxx.cloudfront.net`),用刚才的邮箱和密码,点 **Login with SSO** 登录。

> **`~/.cap-deploy/<账号ID>/` 一定要保留并备份。** 里面的私钥和线上的 CloudFront 公钥配对;丢了也能恢复
> (删掉目录重跑脚本会生成新密钥并更新线上配置),但期间已经发出去的视频链接会失效。

只想看会做什么、不做任何改动:加 `--plan`。

## 三、部署之后

**添加用户**(只能由管理员添加,自助注册是关闭的):

```bash
./infra-aws/scripts/deploy.sh --skip-images --admin-email colleague@example.com
```

或者手动(`<pool-id>` 是 stack 输出 `CognitoIssuer` 最后一段):

```bash
aws cognito-idp admin-create-user --user-pool-id <pool-id> --username <邮箱> \
  --user-attributes Name=email,Value=<邮箱> Name=email_verified,Value=true \
  --message-action SUPPRESS --region us-east-1
aws cognito-idp admin-set-user-password --user-pool-id <pool-id> --username <邮箱> \
  --password '<密码>' --permanent --region us-east-1
```

`email_verified=true` 不能省:登录走的是通用 OIDC,它拒绝邮箱未验证的账号。

**录屏客户端**

- 桌面端 Cap:在设置里把 **Cap Server URL** 改成你的站点地址(设置项已确认存在;登录流程在这个分支上还没有实测过)。
- Chrome 插件:从 Chrome 商店安装官方插件,在插件选项里把 Cap URL 改成你的站点地址。
- iOS App:**不支持**。商店版的服务器地址写死在 App 里(cap.so)。手机上直接用浏览器打开分享页即可。

**行为说明**

- 所有视频都**必须登录**才能看(`CAP_REQUIRE_SIGN_IN_TO_VIEW`),包括设成"公开"的视频;链接预览只显示锁图。
- 邮件不会发出(没有配置发信服务),所以邮箱验证码登录、评论通知、邀请邮件都不可用。
- 每个视频第一次被提问时会生成一次"画面时间线"(抽关键帧 + Sonnet 描述),1 小时录制约 $0.1–0.3。

## 四、日常更新

```bash
git pull
./infra-aws/scripts/deploy.sh            # 重建 web / media-server 镜像并滚动
./infra-aws/scripts/deploy.sh --with-whisper   # 改了 apps/whisper-server/ 时
./infra-aws/scripts/deploy.sh --skip-images    # 只改了 infra-aws/ 时
```

有转写或抽帧任务正在跑时脚本会拒绝滚动(滚动 web 会打断它们),等它们跑完再更新,或者加 `--force`。

合并上游 Cap 的新版本,见 runbook 的「同步上游」一节,里面列了每次合并后必须检查的地方。

## 五、常见问题

| 症状 | 原因与处理 |
|---|---|
| 站点所有请求 504 | 部署时漏了 CloudFront 安全组。用脚本部署不会发生;手动 `cdk deploy` 时必须带 `-c cfVpcOriginSgId=<id>` |
| 视频能播,但没有总结 / 问答报错 | Bedrock 模型没开通,见前提 |
| web 镜像构建突然报 postcss / `__turbopack_context__` 错误 | 构建缓存损坏:`docker builder prune -af` 后重跑 |
| 登录后提示邮箱未验证 | 用户缺少 `email_verified=true`,用 `admin-update-user-attributes` 补上 |
| 转写一直不出 | 看 cap-web 日志里的 `[transcribe]` / `[aws-transcribe]`;在分享页点 Retry Transcription |
| Chrome 插件提示 Could not reach Cap (400) | 插件 ID 不是商店版。自己打包的插件要把 `CAP_CHROME_EXTENSION_ID` 改成它的 ID |

cap-web 的日志在 CloudWatch Logs 里,日志组名以 `CapStack-ComputeWebTaskweb` 开头。

## 六、卸载

```bash
cd infra-aws
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) \
CAP_CLOUDFRONT_PUBLIC_KEY="$(cat ~/.cap-deploy/<账号ID>/cloudfront_public_key.pem)" \
  bunx cdk destroy CapStack
```

为了保护数据,**S3 录像桶和 ECR 镜像仓库会被保留**,Aurora 会先留一份快照。确认不需要后在控制台手动删除,
否则会继续产生存储费用。
