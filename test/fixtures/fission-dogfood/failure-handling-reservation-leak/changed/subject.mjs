export async function run(reserve, release, work) {
  const reservation = await reserve();
  const result = await work(reservation);
  await release(reservation);
  return result;
}
