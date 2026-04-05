// Interactive prompts for CLI — works with Node and Bun

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  process.stdout.write(`\n${question}${defaultValue ? ` [${defaultValue}]` : ''}: `);
  const line = await readline();
  return line.trim() || defaultValue || '';
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = await prompt(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

export async function choose(question: string, options: string[]): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  const answer = parseInt(await prompt('Choose'));
  return isNaN(answer) ? 0 : answer - 1;
}

function readline(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once('data', (data) => resolve(data.toString().trim()));
  });
}
