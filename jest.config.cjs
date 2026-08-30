// Cấu hình Jest cho unit test của Order Service.
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: { "^.+\\.(t|j)s$": "ts-jest" },
  moduleNameMapper: {
    "^@common/(.*)$": "<rootDir>/../../packages/common/$1",
  },
  testEnvironment: "node",
};
