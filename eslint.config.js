const js = require("@eslint/js");
const babelParser = require("@babel/eslint-parser");
const globals = require("globals");

module.exports = [
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2019,
			sourceType: "commonjs",
			parser: babelParser,
			parserOptions: {
				requireConfigFile: false,
				allowImportExportEverywhere: true
			},
			globals: {
				...globals.node,
				...globals.commonjs,
				...globals.mocha
			}
		},
		rules: {
			"indent": ["error", "tab"],
			"linebreak-style": ["error", "unix"],
			"quotes": ["error", "double"],
			"semi": ["error", "always"],
			"no-redeclare": 1,
			"no-trailing-spaces": "error",
			"no-param-reassign": "error",
			"no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
		}
	}
];
