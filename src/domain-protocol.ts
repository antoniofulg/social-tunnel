export const DOMAIN_REQUEST_LIMIT = 4096;
export const DOMAIN_RESPONSE_LIMIT = 96 * 1024;
export const DOMAIN_COMMAND_UNAVAILABLE = 75;
export const DOMAIN_COMMANDS = Object.freeze({
  inspect: "domains-v1 inspect", add: "domains-v1 add", remove: "domains-v1 remove",
  begin: "domains-v1 begin", receipt: "domains-v1 receipt", attest: "domains-v1 attest",
  reconcile: "domains-v1 reconcile",
});
export type DomainVerb = keyof typeof DOMAIN_COMMANDS;
