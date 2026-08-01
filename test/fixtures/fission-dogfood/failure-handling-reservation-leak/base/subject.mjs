export async function run(reserve, release, work) {
  const reservation = await reserve();
  try {
    return await work(reservation);
  } finally {
    await release(reservation);
  }
}
