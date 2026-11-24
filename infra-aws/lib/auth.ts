import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface AuthProps {
	/** App CloudFront 的 https URL */
	readonly appUrl: string;
	/** hosted UI 域名前缀，必须全局唯一 */
	readonly domainPrefix: string;
}

export class Auth extends Construct {
	readonly userPool: cognito.UserPool;
	readonly client: cognito.UserPoolClient;
	readonly clientSecretParameter: secretsmanager.Secret;

	constructor(scope: Construct, id: string, props: AuthProps) {
		super(scope, id);

		this.userPool = new cognito.UserPool(this, "UserPool", {
			signInAliases: { email: true },
			autoVerify: { email: true },
			selfSignUpEnabled: false,
			// Cognito 自带发信，每日 50 封上限，小团队够用；
			// 这样注册验证码不依赖 SES，也就绕开了 SES 沙箱。
			email: cognito.UserPoolEmail.withCognito(),
			standardAttributes: {
				email: { required: true, mutable: false },
			},
			passwordPolicy: {
				minLength: 12,
				requireLowercase: true,
				requireUppercase: true,
				requireDigits: true,
				requireSymbols: false,
			},
			mfa: cognito.Mfa.OPTIONAL,
			mfaSecondFactor: { sms: false, otp: true },
			accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
			removalPolicy: cdk.RemovalPolicy.RETAIN,
		});

		this.userPool.addDomain("HostedUi", {
			cognitoDomain: { domainPrefix: props.domainPrefix },
		});

		this.client = this.userPool.addClient("WebClient", {
			generateSecret: true,
			authFlows: { userSrp: true },
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [
					cognito.OAuthScope.OPENID,
					cognito.OAuthScope.EMAIL,
					cognito.OAuthScope.PROFILE,
				],
				callbackUrls: [`${props.appUrl}/api/auth/callback/oidc`],
				logoutUrls: [`${props.appUrl}/login`],
			},
			preventUserExistenceErrors: true,
		});

		this.clientSecretParameter = new secretsmanager.Secret(
			this,
			"ClientSecret",
			{
				secretStringValue: this.client.userPoolClientSecret,
			},
		);
	}

	get issuer(): string {
		const stack = cdk.Stack.of(this);
		return `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}`;
	}
}
