export async function execute(signal, work) {
  const value = await work(signal);
  if (signal.aborted) return { status: "CANCELLED" };
  return { status: "SUCCESS", value };
}
