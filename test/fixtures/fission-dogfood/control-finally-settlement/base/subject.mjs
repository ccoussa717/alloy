export async function run(reserve, settle, work) {
  const reservation = await reserve();
  try {
    return await work(reservation);
  } finally {
    await settle(reservation);
  }
}
