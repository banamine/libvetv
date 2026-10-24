globalThis.__networkAttempts = 0;
globalThis.fetch = async () => {
  globalThis.__networkAttempts += 1;
  throw new Error("Network access is disabled in unit tests");
};
