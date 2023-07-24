const express = require('express');
const app = express();
const port = 3001;
const axiosInstance = require('./axiosInstance');
const Bottleneck = require('bottleneck');

// Create a limiter for Riots rate limit api
const limiter = new Bottleneck({
  reservoir: 20,
  reservoirRefreshAmount: 20,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 1,
  minTime: 50,
  highWater: 100,
  strategy: Bottleneck.strategy.LEAK
});

const getSummonerByName = async (name) => {
  return limiter.schedule(() => axiosInstance.get(`https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-name/${name}`));
};

const getMatchIds = async (puuid, start) => {
  return limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=1700&start=${start}&count=100`));
};

async function getMatchDetails(matchId) {
  const { data } = await limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`));
  return data;
}

app.get('/getAllGamesArena/:name', async (req, res) => {
  const { name } = req.params;
  const { data } = await getSummonerByName(name);
  const allMatches = [];
  let start = 0;
  let hasMoreMatches = true;

  while (hasMoreMatches) {
    const { data: matchIds } = await getMatchIds(data.puuid, start);
    hasMoreMatches = matchIds.length === 100;

    const matchDetails = await Promise.all(matchIds.map(matchId => getMatchDetails(matchId)));
    allMatches.push(...matchDetails);

    start += 100;
  }

  res.send(allMatches);
});

app.get('/getWinRate/:name', async (req, res) => {
  const { name } = req.params;
  const { data } = await getSummonerByName(name);
  const allMatches = [];
  let start = 0;
  let hasMoreMatches = true;

  while (hasMoreMatches) {
    const { data: matchIds } = await getMatchIds(data.puuid, start);
    hasMoreMatches = matchIds.length === 100;

    const matchDetails = await Promise.all(matchIds.map(matchId => getMatchDetails(matchId)));
    allMatches.push(...matchDetails);

    start += 100;
  }

  // Create a map to track wins and total games for each teammate
  const teammateStats = new Map();

  for (const match of allMatches) {
    const player = match.info.participants.find(participant => participant.puuid === data.puuid);
    const teammates = match.info.participants.filter(participant => participant.teamId === player.teamId && participant.puuid !== data.puuid);

    for (const teammate of teammates) {
      const stats = teammateStats.get(teammate.puuid) || { summonerName: teammate.summonerName, wins: 0, total: 0 };

      stats.total++;
      if (player.win) {
        stats.wins++;
      }

      teammateStats.set(teammate.puuid, stats);
    }
  }

  // Calculate win rate for each teammate
  const winRates = [];

  for (const stats of teammateStats.values()) {
    if (stats.total > 2) {
      winRates.push({ summonerName: stats.summonerName, winRate: ((stats.wins / stats.total) * 100).toFixed(2), totalGames: stats.total });
    }
  }

  res.send(winRates.sort((a, b) => b.totalGames - a.totalGames));
});

app.get('/', (_, res) => {
  res.send('Hello World!')
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});
