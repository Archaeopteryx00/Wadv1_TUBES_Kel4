require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('./middleware/auth');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Redirect root to standings page
app.get('/', (req, res) => {
  res.redirect('/standings.html');
});

// Authentication
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  
  if (password === adminPassword) {
    const token = jwt.sign(
      { role: 'admin' },
      process.env.JWT_SECRET || 'worldcupsimulatorsecret123',
      { expiresIn: '24h' }
    );
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid password' });
});

// Teams API
app.get('/api/teams', async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      orderBy: { group: 'asc' }
    });
    res.json(teams);
  } catch (error) {
    next(error);
  }
});

app.post('/api/teams', authMiddleware, async (req, res, next) => {
  try {
    const { name, code, group } = req.body;
    if (!name || !code || !group) {
      return res.status(400).json({ error: 'All fields (name, code, group) are required' });
    }
    
    const formattedName = name.trim();
    const formattedCode = code.toUpperCase().trim();
    const formattedGroup = group.toUpperCase().trim();

    if (formattedCode.length !== 3) {
      return res.status(400).json({ error: 'Team code must be exactly 3 characters (e.g. ARG)' });
    }

    const newTeam = await prisma.team.create({
      data: {
        name: formattedName,
        code: formattedCode,
        group: formattedGroup
      }
    });
    res.status(201).json(newTeam);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Team name or code already exists.' });
    }
    next(error);
  }
});

// Helper: Calculate Standings
async function calculateGroupStandings(groupName) {
  const teams = await prisma.team.findMany({
    where: { group: groupName }
  });

  const teamIds = teams.map(t => t.id);
  const finishedMatches = await prisma.match.findMany({
    where: {
      phase: 'group',
      status: 'finished',
      OR: [
        { homeTeamId: { in: teamIds } },
        { awayTeamId: { in: teamIds } }
      ]
    }
  });

  const standings = teams.map(team => ({
    team,
    played: 0,
    won: 0,
    draw: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    points: 0
  }));

  const standingsMap = new Map(standings.map(s => [s.team.id, s]));

  for (const match of finishedMatches) {
    const home = standingsMap.get(match.homeTeamId);
    const away = standingsMap.get(match.awayTeamId);
    if (!home || !away) continue;

    home.played++;
    away.played++;
    home.goalsFor += match.scoreHome;
    home.goalsAgainst += match.scoreAway;
    away.goalsFor += match.scoreAway;
    away.goalsAgainst += match.scoreHome;

    if (match.scoreHome > match.scoreAway) {
      home.won++;
      home.points += 3;
      away.lost++;
    } else if (match.scoreHome < match.scoreAway) {
      away.won++;
      away.points += 3;
      home.lost++;
    } else {
      home.draw++;
      home.points += 1;
      away.draw++;
      away.points += 1;
    }
  }

  for (const row of standings) {
    row.goalDifference = row.goalsFor - row.goalsAgainst;
  }

  // Sort logic: 1. Points DESC, 2. GD DESC, 3. GF DESC, 4. Name ASC
  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return a.team.name.localeCompare(b.team.name);
  });

  return standings;
}

// Groups & Standings API
app.get('/api/groups', async (req, res, next) => {
  try {
    const groups = await prisma.team.findMany({
      select: { group: true },
      distinct: ['group']
    });
    res.json(groups.map(g => g.group).sort());
  } catch (error) {
    next(error);
  }
});

app.get('/api/groups/:groupName/standings', async (req, res, next) => {
  try {
    const groupName = req.params.groupName.toUpperCase().trim();
    const teamCount = await prisma.team.count({
      where: { group: groupName }
    });
    if (teamCount === 0) {
      return res.status(404).json({ error: `Group ${groupName} not found or has no teams` });
    }
    const standings = await calculateGroupStandings(groupName);
    res.json(standings);
  } catch (error) {
    next(error);
  }
});

app.get('/api/standings', async (req, res, next) => {
  try {
    const groups = await prisma.team.findMany({
      select: { group: true },
      distinct: ['group']
    });
    const sortedGroups = groups.map(g => g.group).sort();
    const allStandings = {};
    for (const group of sortedGroups) {
      allStandings[group] = await calculateGroupStandings(group);
    }
    res.json(allStandings);
  } catch (error) {
    next(error);
  }
});

// Matches API
app.get('/api/matches', async (req, res, next) => {
  try {
    const { phase, status } = req.query;
    const filter = {};
    if (phase) filter.phase = phase;
    if (status) filter.status = status;

    const matches = await prisma.match.findMany({
      where: filter,
      include: {
        homeTeam: true,
        awayTeam: true
      },
      orderBy: [
        { phase: 'asc' },
        { round: 'desc' },
        { id: 'asc' }
      ]
    });
    res.json(matches);
  } catch (error) {
    next(error);
  }
});

app.put('/api/matches/:id/result', authMiddleware, async (req, res, next) => {
  try {
    const matchId = parseInt(req.params.id);
    const { scoreHome, scoreAway } = req.body;

    if (isNaN(matchId)) {
      return res.status(400).json({ error: 'Invalid match ID' });
    }
    if (scoreHome === undefined || scoreAway === undefined || scoreHome === null || scoreAway === null) {
      return res.status(400).json({ error: 'scoreHome and scoreAway are required' });
    }

    const sHome = parseInt(scoreHome);
    const sAway = parseInt(scoreAway);
    if (isNaN(sHome) || isNaN(sAway) || sHome < 0 || sAway < 0) {
      return res.status(400).json({ error: 'Scores must be non-negative integers' });
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId }
    });

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (match.phase === 'knockout' && sHome === sAway) {
      return res.status(400).json({ error: 'Knockout matches cannot end in a draw. Please input a winner.' });
    }

    const updatedMatch = await prisma.match.update({
      where: { id: matchId },
      data: {
        scoreHome: sHome,
        scoreAway: sAway,
        status: 'finished'
      },
      include: {
        homeTeam: true,
        awayTeam: true
      }
    });

    res.json(updatedMatch);
  } catch (error) {
    next(error);
  }
});

// Tournament Administration API
app.post('/api/tournament/setup', authMiddleware, async (req, res, next) => {
  try {
    await prisma.match.deleteMany({});

    const teams = await prisma.team.findMany();
    if (teams.length === 0) {
      return res.status(400).json({ error: 'Cannot setup tournament: No teams found. Please add teams first.' });
    }

    const groups = {};
    for (const team of teams) {
      if (!groups[team.group]) {
        groups[team.group] = [];
      }
      groups[team.group].push(team);
    }

    for (const groupName in groups) {
      if (groups[groupName].length < 2) {
        return res.status(400).json({
          error: `Group ${groupName} only has ${groups[groupName].length} team(s). Every group must have at least 2 teams.`
        });
      }
    }

    const matchesToCreate = [];

    // Round Robin within each group
    for (const groupName in groups) {
      const groupTeams = groups[groupName];
      for (let i = 0; i < groupTeams.length; i++) {
        for (let j = i + 1; j < groupTeams.length; j++) {
          matchesToCreate.push({
            homeTeamId: groupTeams[i].id,
            awayTeamId: groupTeams[j].id,
            phase: 'group',
            status: 'scheduled'
          });
        }
      }
    }

    if (matchesToCreate.length > 0) {
      await prisma.match.createMany({
        data: matchesToCreate
      });
    }

    res.json({
      message: 'Tournament setup successful. All group stage matches have been scheduled.',
      matchesCreated: matchesToCreate.length
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tournament/advance', authMiddleware, async (req, res, next) => {
  try {
    const totalMatches = await prisma.match.count();
    if (totalMatches === 0) {
      return res.status(400).json({ error: 'Tournament has not been set up. Please setup the tournament first.' });
    }

    const groupMatches = await prisma.match.findMany({
      where: { phase: 'group' }
    });

    const knockoutMatches = await prisma.match.findMany({
      where: { phase: 'knockout' }
    });

    // Scenario A: Advancing from Group Stage to First Knockout Round
    if (groupMatches.length > 0 && knockoutMatches.length === 0) {
      const unfinishedGroup = groupMatches.some(m => m.status !== 'finished');
      if (unfinishedGroup) {
        return res.status(400).json({ error: 'Cannot advance: Not all group stage matches are finished.' });
      }

      const groups = await prisma.team.findMany({
        select: { group: true },
        distinct: ['group']
      });
      const sortedGroups = groups.map(g => g.group).sort();

      const firsts = [];
      const seconds = [];

      for (const groupName of sortedGroups) {
        const standings = await calculateGroupStandings(groupName);
        if (standings.length >= 1) firsts.push(standings[0].team);
        if (standings.length >= 2) seconds.push(standings[1].team);
      }

      const totalQualifiers = firsts.length + seconds.length;
      if (totalQualifiers < 2) {
        return res.status(400).json({ error: 'Not enough qualifying teams to start knockout phase.' });
      }

      let roundName = "2";
      if (totalQualifiers >= 16) {
        roundName = "16";
      } else if (totalQualifiers >= 8) {
        roundName = "8";
      } else if (totalQualifiers >= 4) {
        roundName = "4";
      }

      const numMatches = firsts.length;
      const matchesToCreate = [];

      for (let i = 0; i < numMatches; i++) {
        const homeTeam = firsts[i];
        // Pair first of group i with second of group (i + 1) % numMatches
        const awayTeam = seconds.length > 0 ? seconds[(i + 1) % seconds.length] : null;

        if (homeTeam && awayTeam) {
          matchesToCreate.push({
            homeTeamId: homeTeam.id,
            awayTeamId: awayTeam.id,
            phase: 'knockout',
            status: 'scheduled',
            round: roundName
          });
        }
      }

      if (matchesToCreate.length === 0) {
        return res.status(400).json({ error: 'Failed to pair teams for knockout phase.' });
      }

      await prisma.match.createMany({
        data: matchesToCreate
      });

      return res.json({
        message: `Advanced to Knockout Stage (Round of ${matchesToCreate.length * 2}).`,
        round: roundName,
        matchesCreated: matchesToCreate.length
      });

    } else if (knockoutMatches.length > 0) {
      // Scenario B: Advancing within the Knockout Stage
      const rounds = ["16", "8", "4", "2"];
      
      const unfinishedKnockout = knockoutMatches.filter(m => m.status !== 'finished');
      if (unfinishedKnockout.length > 0) {
        const activeRound = unfinishedKnockout[0].round;
        return res.status(400).json({ error: `Cannot advance: Not all matches in Round of ${activeRound === "2" ? "2 (Final)" : activeRound} are finished.` });
      }

      let latestCompletedRound = null;
      for (const r of rounds) {
        if (knockoutMatches.some(m => m.round === r)) {
          latestCompletedRound = r;
        }
      }

      if (latestCompletedRound === "2") {
        const finalMatch = knockoutMatches.find(m => m.round === "2");
        let winnerName = "Unknown";
        if (finalMatch && finalMatch.status === 'finished') {
          const winnerId = finalMatch.scoreHome > finalMatch.scoreAway ? finalMatch.homeTeamId : finalMatch.awayTeamId;
          const winnerTeam = await prisma.team.findUnique({ where: { id: winnerId } });
          if (winnerTeam) winnerName = winnerTeam.name;
        }
        return res.status(400).json({ error: `Tournament is already complete! Winner: ${winnerName}.` });
      }

      const currentIndex = rounds.indexOf(latestCompletedRound);
      if (currentIndex === -1 || currentIndex === rounds.length - 1) {
        return res.status(400).json({ error: 'Cannot advance: Invalid tournament state.' });
      }
      const nextRound = rounds[currentIndex + 1];

      const completedMatches = await prisma.match.findMany({
        where: { phase: 'knockout', round: latestCompletedRound },
        orderBy: { id: 'asc' }
      });

      const winners = completedMatches.map(m => {
        return m.scoreHome > m.scoreAway ? m.homeTeamId : m.awayTeamId;
      });

      if (winners.length < 2 || winners.length % 2 !== 0) {
        return res.status(400).json({ error: `Cannot advance: Invalid number of winners (${winners.length}) in round ${latestCompletedRound}.` });
      }

      const matchesToCreate = [];
      for (let i = 0; i < winners.length; i += 2) {
        matchesToCreate.push({
          homeTeamId: winners[i],
          awayTeamId: winners[i + 1],
          phase: 'knockout',
          status: 'scheduled',
          round: nextRound
        });
      }

      await prisma.match.createMany({
        data: matchesToCreate
      });

      return res.json({
        message: `Advanced to Round of ${nextRound === "2" ? "2 (Final)" : nextRound === "4" ? "4 (Semi-finals)" : nextRound}.`,
        round: nextRound,
        matchesCreated: matchesToCreate.length
      });
    } else {
      return res.status(400).json({ error: 'Cannot advance: No matches exist.' });
    }
  } catch (error) {
    next(error);
  }
});

// Bracket API
app.get('/api/bracket', async (req, res, next) => {
  try {
    const matches = await prisma.match.findMany({
      where: { phase: 'knockout' },
      include: {
        homeTeam: true,
        awayTeam: true
      },
      orderBy: { id: 'asc' }
    });

    const bracket = {
      "16": [],
      "8": [],
      "4": [],
      "2": []
    };

    for (const match of matches) {
      if (bracket[match.round]) {
        bracket[match.round].push(match);
      }
    }

    res.json(bracket);
  } catch (error) {
    next(error);
  }
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err);
  // Specific check for database connection issues
  if (err.message && err.message.includes('Can\'t reach database server')) {
    return res.status(500).json({ error: 'Database connection failed. Please ensure your DATABASE_URL in .env is correct and database is online.' });
  }
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
