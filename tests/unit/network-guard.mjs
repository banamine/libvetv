globalThis.fetch = async () => {
  throw new Error("Network access is disabled in unit tests");
};
