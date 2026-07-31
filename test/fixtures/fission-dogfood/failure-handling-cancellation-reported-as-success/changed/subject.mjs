export async function execute(signal, work) {
  const value = await work(signal);
  return { status: "SUCCESS", value };
}
