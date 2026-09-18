const DOCKER_FORMAT = "{{.Names}}\\t{{.State}}\\t{{.Image}}\\t{{.Status}}";

export function dockerDiscoveryArgs(mode = "running") {
  return ["ps", ...(mode === "all" ? ["-a"] : []), "--format", DOCKER_FORMAT];
}

export function mergeServices(configuredServices = [], dockerServices = [], mode = "merge") {
  if (mode === "replace") return dockerServices;
  const names = new Set(configuredServices.map((service) => service.name));
  return configuredServices.concat(dockerServices.filter((service) => !names.has(service.name)));
}
