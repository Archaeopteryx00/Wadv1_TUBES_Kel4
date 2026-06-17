const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const teams = [
  // Group A
  { name: 'Argentina', code: 'ARG', group: 'A' },
  { name: 'Prancis', code: 'FRA', group: 'A' },
  { name: 'Arab Saudi', code: 'KSA', group: 'A' },
  { name: 'Polandia', code: 'POL', group: 'A' },
  
  // Group B
  { name: 'Inggris', code: 'ENG', group: 'B' },
  { name: 'Amerika Serikat', code: 'USA', group: 'B' },
  { name: 'Iran', code: 'IRN', group: 'B' },
  { name: 'Wales', code: 'WAL', group: 'B' }
];

async function main() {
  console.log('Clearing old teams and matches...');
  await prisma.match.deleteMany({});
  await prisma.team.deleteMany({});

  console.log('Seeding teams...');
  for (const team of teams) {
    const created = await prisma.team.create({
      data: team
    });
    console.log(`Created team: ${created.name} (${created.code}) in Group ${created.group}`);
  }

  console.log('Seeding finished successfully.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
