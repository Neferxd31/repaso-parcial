const readline = require('node:readline');

const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';
const history = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'Tú: ' });

async function main() {
  rl.prompt();
  for await (const text of rl) {
    if (text === 'salir') break;

    history.push({ role: 'user', parts: [{ text }] });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: history }),
    });
    const data = await response.json();

    if (data.error) {
      console.log('Error:', data.error.message);
      history.pop();
    } else {
      const reply = data.candidates[0].content.parts.map((part) => part.text).join('');
      history.push({ role: 'model', parts: [{ text: reply }] });
      console.log(`Gemini: ${reply}\n`);
    }
    rl.prompt();
  }
  rl.close();
}

main();
