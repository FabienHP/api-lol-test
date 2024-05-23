import express from 'express';
import Bottleneck from 'bottleneck';
import axiosInstance from './axiosInstance.js';
import expressListEndpoints from 'express-list-endpoints';
import { createCanvas, loadImage } from 'canvas';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from 'console';

const app = express();
const port = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const championImageCacheDir = path.join(__dirname, 'champion_images');
const checkmarkImagePath = path.join(__dirname, 'checkmark.png');

// Ensure the cache directory exists
fs.ensureDirSync(championImageCacheDir);

// Create a limiter for Riot's rate limit API
const limiter = new Bottleneck({
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 2 * 60 * 1000,
  maxConcurrent: 1,
  minTime: 50,
});

// Retry limiter for handling rate limiting
limiter.on('failed', async (error, _) => {
  if (error.response && error.response.status === 429) {
    const retryAfter = parseInt(error.response.headers['retry-after']) || 1;
    console.log(`Rate limit exceeded. Retrying after ${retryAfter} seconds.`);
    return retryAfter * 1000;
  }
});

const getAccountByRiotID = async (gameName, tagLine) => {
  return limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`));
};

const getArenaMatchIds = async (puuid, start) => {
  return limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=1709247600&queue=1700&start=${start}&count=100`));
};

const getMatchDetails = async (matchId) => {
  const { data } = await limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`));
  return data;
};

const getAllChampions = async () => {
  const { data } = await axios.get('https://ddragon.leagueoflegends.com/cdn/14.10.1/data/en_US/champion.json');
  return Object.keys(data.data).sort();
};

const getCachedChampionImage = async (championName) => {
  const imagePath = path.join(championImageCacheDir, `${championName}.png`);
  if (await fs.pathExists(imagePath)) {
    return loadImage(imagePath);
  } else {
    const url = `https://ddragon.leagueoflegends.com/cdn/14.10.1/img/champion/${championName}.png`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(imagePath, response.data);
    return loadImage(imagePath);
  }
};

app.get('/getAllArenaGames/:gameName/:tagLine', async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    const { data } = await getAccountByRiotID(gameName, tagLine);
    const allMatches = [];
    let start = 0;
    let hasMoreMatches = true;

    while (hasMoreMatches) {
      const { data: matchIds } = await getArenaMatchIds(data.puuid, start);
      hasMoreMatches = matchIds.length === 100;

      const matchDetails = await Promise.all(matchIds.map(matchId => getMatchDetails(matchId)));
      allMatches.push(...matchDetails);

      start += 100;
    }

    res.send(allMatches);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching data from Riot Games API.');
  }
});

app.get('/getArenaWinRate/:gameName/:tagLine', async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    const { data } = await getAccountByRiotID(gameName, tagLine);
    const allMatches = [];
    let start = 0;
    let hasMoreMatches = true;

    while (hasMoreMatches) {
      const { data: matchIds } = await getArenaMatchIds(data.puuid, start);
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
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching data from Riot Games API.');
  }
});

app.get('/getChampionsPlayed/:gameName/:tagLine', async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    const { data } = await getAccountByRiotID(gameName, tagLine);
    const allMatches = [];
    let start = 0;
    let hasMoreMatches = true;

    while (hasMoreMatches) {
      const { data: matchIds } = await getArenaMatchIds(data.puuid, start);
      hasMoreMatches = matchIds.length === 100;

      const matchDetails = await Promise.all(matchIds.map(matchId => getMatchDetails(matchId)));
      allMatches.push(...matchDetails);

      start += 100;
    }

    const championsPlayed = new Set();

    for (const match of allMatches) {
      const player = match.info.participants.find(participant => participant.puuid === data.puuid);
      if (player) {
        championsPlayed.add(player.championName);
      }
    }

    const allChampions = await getAllChampions();

    // Generate the image
    const canvasWidth = 1198;
    const canvasHeight = 828;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#453716';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = '#020A13';
    ctx.fillRect(2, 2, canvasWidth - 4, canvasHeight - 4);

    const championImages = await Promise.all(
      allChampions.map(name => getCachedChampionImage(name))
    );

    const checkMark = await loadImage(checkmarkImagePath);

    let x = 10;
    let y = 10;
    const imageSize = 64;
    const padding = 10;

    championImages.forEach((image, index) => {
      if (x + imageSize > canvasWidth) {
        x = 10;
        y += imageSize + padding;
      }
      ctx.drawImage(image, x, y, imageSize, imageSize);
      if (championsPlayed.has(allChampions[index])) {
        ctx.fillStyle = '#00000099';
        ctx.fillRect(x, y, imageSize, imageSize);
        ctx.drawImage(checkMark, x + imageSize - 14, y - 6, 20, 20);
      }
      x += imageSize + padding;
    });

    res.setHeader('Content-Type', 'image/png');
    canvas.createPNGStream().pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching data from Riot Games API.');
  }
});

app.get('/', (_, res) => {
  const endpoints = expressListEndpoints(app);
  let response = '<h1>Available Routes</h1><ul>';

  endpoints.forEach(endpoint => {
    endpoint.methods.forEach(method => {
      response += `<li><strong>${method}</strong> ${endpoint.path}</li>`;
    });
  });

  response += '</ul>';
  res.send(response);
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
