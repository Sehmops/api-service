import express from 'express';
import axios from 'axios';
import jwt_decode from 'jwt-decode';
import { Redis } from 'ioredis';
import CONFIG from './config.json' assert { type: 'json' };

const app = express();
const SERVER_PORT = CONFIG.SERVER_PORT;
const API_USER = CONFIG.API_USER;
const API_PASSWORD = CONFIG.API_PASSWORD;
const REDIS_HOST = CONFIG.REDIS_HOST;
const REDIS_PASSWORD = CONFIG.REDIS_PASSWORD;
const REDIS_PORT = CONFIG.REDIS_PORT;

const redis = new Redis({
	port: REDIS_PORT,
	host: REDIS_HOST,
	password: REDIS_PASSWORD,
	db: 0,
	tls: {
		host: REDIS_HOST
	}
})

let accessToken

const authenticate = async () => {
        console.log('Authenticating...');
	return await axios.get('https://login.meteomatics.com/api/v1/token', {
		headers: {'authorization': 'Basic ' + btoa(API_USER + ':' + API_PASSWORD)}
	}).then(resp => {
		console.log('Success');
		accessToken = resp.data.access_token;
        })
	.catch(err => {
                console.log('something went wrong', err);
        });
}

const checkToken = () => {
        // no token provided
        if(!accessToken) {
                console.log('No token provided');
                return false;
        }
	let decodedToken;
	try{
		decodedToken = jwt_decode(accessToken);
	} catch (error) {
		console.log("Error decoding accessToken", error);
		return false;
	}
        // check wether token is expired
        let isTokenValid = Date.now() < decodedToken.exp * 1000;
        if(isTokenValid) {
                console.log('Token is valid');
        } else {
                console.log('Token expired');
        }
        return isTokenValid;
}

const getFromRedis = async (key) => {
	const response = await redis.hgetall(key);
	response.status = Number(response.status);
	//if temp was undefined, it gets converted to empty string by redis
	if(response.temp === "") {
		response.temp = undefined;
	} else {
		response.temp = Number(response.temp)
	}
	return response;
}

const addToRedis = (key, value) => {
	redis.hset(key, value);
	redis.expire(key, 3600);
} 

const getTempFromApi = async (postCode) => {
	const response = {status: 500, postCode: postCode, temp: undefined}
	if (!(/^\d{5}$/.test(postCode))) {
		response.status = 400;
		return response;
	}
	while(!checkToken()){
		await authenticate();
	}
	return await axios.get(`https://api.meteomatics.com/now/t_2m:C/postal_DE${postCode}/json?access_token=${accessToken}`)
		.then(resp => 
			resp.data
		)
		.then(data => {
			response.temp = data.data[0].coordinates[0].dates[0].value;
			response.status = 200;
			return response;
		})
		.catch(err => {
			console.log('api request failed', err.response.data);
			response.status = err.response.status
			return response;
		});
}

app.get('/postCode/:postCode', async (req, res) => {
	const postCode = req.params.postCode;
	let response;
	redis.exists(postCode, async (err, reply) => {
		if (reply === 1){
			console.log('Cache Hit');
			response = await getFromRedis(postCode);
		}else {
			console.log('Cache Miss');
			response = await getTempFromApi(postCode);
			addToRedis(postCode, response);
		}
		console.log(`temp at ${postCode} is ${response.temp}`)
		res.status(response.status).send({postCode: postCode, temp: response.temp});
	});
});

app.get('/', (req, res) => {
	console.log('alive request');
	return res.sendStatus(200);
});

app.listen(SERVER_PORT, () => console.log(`Server listening on port ${SERVER_PORT}`))
