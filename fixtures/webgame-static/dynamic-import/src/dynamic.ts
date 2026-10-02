export async function loadRenderer(moduleName: string) {
  return import(moduleName);
}
