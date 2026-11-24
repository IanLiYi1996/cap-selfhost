import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/** 32 字节 hex，CDK 生成后我们从不读取明文 */
function hexSecret(scope: Construct, id: string): secretsmanager.Secret {
	return new secretsmanager.Secret(scope, id, {
		generateSecretString: {
			passwordLength: 64,
			excludePunctuation: true,
			excludeUppercase: true,
			excludeCharacters: "ghijklmnopqrstuvwxyz",
		},
	});
}

export class AppSecrets extends Construct {
	readonly nextAuthSecret: secretsmanager.Secret;
	readonly databaseEncryptionKey: secretsmanager.Secret;
	readonly mediaServerWebhookSecret: secretsmanager.Secret;
	readonly cloudFrontPrivateKey: secretsmanager.Secret;
	readonly databaseUrl: secretsmanager.Secret;

	constructor(scope: Construct, id: string) {
		super(scope, id);

		this.nextAuthSecret = hexSecret(this, "NextAuthSecret");
		// 一旦有数据就不能再改：用户自定义 S3 凭据是用它加密存库的
		// (apps/web/app/api/desktop/[...route]/s3Config.ts)
		this.databaseEncryptionKey = hexSecret(this, "DatabaseEncryptionKey");
		this.mediaServerWebhookSecret = hexSecret(this, "MediaServerWebhookSecret");

		// 这两个必须部署后手工填入：私钥要与 CDK 里的公钥配对，
		// DATABASE_URL 若在 CDK 里拼装会把明文密码落进 task definition。
		this.cloudFrontPrivateKey = new secretsmanager.Secret(
			this,
			"CloudFrontPrivateKey",
			{ description: "PEM private key paired with the CloudFront public key" },
		);
		this.databaseUrl = new secretsmanager.Secret(this, "DatabaseUrl", {
			description: "Full mysql:// URL including ?ssl={...}",
		});
	}
}
