import { generateReply } from "../src/systems/aiSystem";

async function test() {
  console.log("Testing generateReply...");
  try {
    const reply = await generateReply("hello!");
    console.log("Reply:", reply);
  } catch (err) {
    console.error("Error:", err);
  }
}
test();
