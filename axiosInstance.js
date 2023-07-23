const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const axiosInstance = axios.create({
  headers: {
    'X-Riot-Token': process.env.RIOT_API_KEY,
    'Content-Type': 'application/json',
  },
});

module.exports = axiosInstance;
