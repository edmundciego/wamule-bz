export function getNetlifyBuildScript(environment) {
  const runningOnNetlify = Boolean(environment.NETLIFY || environment.NETLIFY_CONTEXT);
  if (runningOnNetlify && !environment.BRANCH?.trim()) {
    throw new Error("Netlify build is missing its source branch; refusing to guess a deploy target.");
  }
  return environment.BRANCH === "staging" ? "build:staging" : "build";
}
