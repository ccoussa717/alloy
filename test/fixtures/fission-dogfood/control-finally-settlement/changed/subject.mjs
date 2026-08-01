export async function run(reserve, settle, work) {
  const reservation = await reserve();
  let outcome;
  try {
    outcome = await work(reservation);
    return outcome;
  } finally {
    await settle(reservation);
  }
}
