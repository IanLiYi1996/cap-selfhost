if (!process.env.CAP_CLOUDFRONT_PUBLIC_KEY) {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");
}
