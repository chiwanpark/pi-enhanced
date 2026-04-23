const config = {
	useTabs: true,
	semi: true,
	singleQuote: false,
	trailingComma: "all",
	printWidth: 120,
	overrides: [
		{
			files: ["*.json", "*.jsonc", "*.md", "*.yml", "*.yaml"],
			options: {
				useTabs: false,
			},
		},
	],
};

export default config;
