export async function save(path, bytes, fs) {
  const temporary = `${path}.tmp`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, path);
}
