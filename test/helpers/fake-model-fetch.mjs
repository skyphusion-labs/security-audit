// Preload for the CLI subprocess tests: replaces fetch so the model call returns scripted
// replies (FAKE_MODEL_REPLIES, a JSON array of message-content strings). Each call consumes
// the next reply; the last one repeats. The call count is printed on exit so a test can
// tell whether the compact retry ran.
const replies = JSON.parse(process.env.FAKE_MODEL_REPLIES || "[]");
let calls = 0;
globalThis.fetch = async () => {
  const content = replies[Math.min(calls, replies.length - 1)];
  calls++;
  return new Response(JSON.stringify({ success: true, result: { choices: [{ message: { content } }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
process.on("exit", () => {
  process.stderr.write(`FAKE_FETCH_CALLS=${calls}\n`);
});
