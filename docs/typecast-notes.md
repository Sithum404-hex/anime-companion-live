To use the Typecast API, you’ll need to authenticate your requests with an API key. Follow these steps:
1
First Step

Visit your Typecast API Console to generate a new API key
2
Second Step

Keep your API key secure - we recommend storing it as an environment variable
​
Make your first request
SDK
Direct API
You can set up your API key in two ways:
Configure it directly in your application code
Set it as a shell environment variable

Shell (Linux/macOS)

Shell (Windows)

# Set for current session

set TYPECAST_API_KEY=YOUR_API_KEY

Python

Javascript

Java

C#

cURL
import fs from "fs";
const apiKey = process.env.TYPECAST_API_KEY || 'YOUR_API_KEY';

async function convertTextToSpeech() {
const url = 'https://api.typecast.ai/v1/text-to-speech';
const payload = {
text: "Everything is going to be okay.",
model: "ssfm-v30",
voice_id: "tc_672c5f5ce59fac2a48faeaee",
prompt: {
emotion_type: "smart",
previous_text: "I just got the best news!",
next_text: "I can't wait to celebrate!"
}
};

try {
const response = await fetch(url, {
method: 'POST',
headers: {
'X-API-KEY': apiKey,
'Content-Type': 'application/json'
},
body: JSON.stringify(payload)
});

    if (!response.ok) {
      throw new Error(`Error: ${response.status} - ${await response.text()}`);
    }

    const audioData = await response.arrayBuffer();
    fs.writeFileSync('typecast.wav', Buffer.from(audioData));
    console.log('Audio file saved as typecast.wav');

} catch (error) {
console.error('Error converting text to speech:', error);
}
}

convertTextToSpeech();
​
Audio Output Settings
You can customize the audio output by adding an output object to your request:
Parameter Type Range Default Description
volume integer 0–200 100 Relative volume scaling. Cannot be used with target_lufs.
target_lufs number -70–0 — Absolute loudness normalization in LUFS. Cannot be used with volume.
audio_pitch integer -12–12 0 Pitch adjustment in semitones.
audio_tempo number 0.5–2.0 1.0 Speed multiplier.
audio_format string wav, mp3 wav Output audio format.
Use target_lufs for consistent loudness across different clips. Use volume for simple relative scaling.
Example: output with target_lufs
{
"text": "Consistent loudness example.",
"model": "ssfm-v30",
"voice_id": "tc_672c5f5ce59fac2a48faeaee",
"output": {
"target_lufs": -14.0,
"audio_format": "mp3"
}
}
To browse and select available voice IDs for your requests, please refer to Listing all voices in our API Reference.
​
List all voices
To use Typecast effectively, you need access to voice IDs. The /v2/voices endpoint provides a complete list of available voices with their unique identifiers, names, supported models, and emotions.
You can filter voices by model, gender, age, and use cases using optional query parameters.
You can preview available API voices and listen to sample audio without making an API call on the Voices page. Use it to compare voices first, then copy the Voice ID into your API request.
SDK
Direct API

Python

Javascript

Java

C#

cURL
const apiKey = process.env.TYPECAST_API_KEY || 'YOUR_API_KEY';

async function getVoices() {
const url = 'https://api.typecast.ai/v2/voices';
const params = new URLSearchParams({model: 'ssfm-v30'}); // Optional: model, gender, age, use_cases

try {
const response = await fetch(`${url}?${params}`, {
method: 'GET',
headers: {'X-API-KEY': apiKey}
});

    if (!response.ok) {
      throw new Error(`Error: ${response.status} - ${await response.text()}`);
    }

    const voices = await response.json();
    console.log(`Found ${voices.length} voices:`);
    voices.forEach(voice => {
      voice.models.forEach(model => {
        console.log(`ID: ${voice.voice_id}, Name: ${voice.voice_name}, Model: ${model.version}, Emotions: ${model.emotions.join(', ')}`);
      });
    });

} catch (error) {
console.error('Error fetching voices:', error);
}
}

getVoices();
The response will be a JSON array of voice objects, each containing:
{
"voice_id": "tc_672c5f5ce59fac2a48faeaee",
"voice_name": "Dylan",
"models": [
{
"version": "ssfm-v30",
"emotions": ["normal", "happy", "sad", "angry", "whisper", "toneup", "tonedown"]
}
],
"gender": "male",
"age": "young_adult",
"use_cases": ["Conversational", "TikTok/Reels/Shorts", "Audiobook/Storytelling"]
}
You’ll need a valid voice ID when making text-to-speech requests. With ssfm-v30, all 7 emotion presets are available across all voices.
​
Stream audio in real time
For low-latency applications, use the streaming endpoint to play audio as chunks arrive — no need to wait for full synthesis.
WAV streaming format: 32000 Hz, 16-bit, mono PCM. The first chunk includes a 44-byte WAV header; subsequent chunks are raw PCM only.
SDK
Direct API

Python

cURL + ffplay

# pip install requests sounddevice

import requests
import sounddevice as sd
import os

api_key = os.environ.get("TYPECAST_API_KEY", "YOUR_API_KEY")

response = requests.post(
"https://api.typecast.ai/v1/text-to-speech/stream",
headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
json={
"text": "Stream this text as audio in real time.",
"model": "ssfm-v30",
"voice_id": "tc_672c5f5ce59fac2a48faeaee",
"output": {"audio_format": "wav", "target_lufs": -14.0},
},
stream=True
)
response.raise_for_status()

with sd.RawOutputStream(samplerate=32000, channels=1, dtype="int16") as player:
buf, first = bytearray(), True
for chunk in response.iter_content(chunk_size=4096):
if not chunk:
continue
if first:
chunk = chunk[44:] # Skip WAV header
first = False
buf.extend(chunk)
n = len(buf) - (len(buf) % 2)
if n:
player.write(bytes(buf[:n]))
del buf[:n]
Parameter Type Range Default Description
audio_pitch integer -12–12 0 Pitch adjustment in semitones.
audio_tempo number 0.5–2.0 1.0 Speed multiplier.
audio_format string wav, mp3 wav Output audio format.
target_lufs number -70–0 — Absolute loudness normalization in LUFS.
Use target_lufs to keep streaming audio loudness consistent across clips. volume is not supported in streaming mode.
​
Generate subtitles with Timestamp TTS
Need word-level timing for captions, karaoke, or lip-sync? Use the timestamp TTS endpoint — it returns the audio together with per-word (and optionally per-character) alignment data.

Python

Javascript

cURL
import { TypecastClient } from '@neosapience/typecast-js';
import fs from 'fs';

const client = new TypecastClient({ apiKey: 'YOUR_API_KEY' });
const result = await client.textToSpeechWithTimestamps({
text: "Hello. How are you?",
model: "ssfm-v30",
voice_id: "tc_60e5426de8b95f1d3000d7b5",
});

await fs.promises.writeFile("output.wav", result.audioBytes());
await fs.promises.writeFile("output.srt", result.toSrt(), "utf-8");
See each SDK documentation for all 11 language examples including subtitle export helpers (toSrt(), toVtt()).
​
Next steps
Congratulations on creating your first AI voice! Here are some resources to help you dive deeper:
API Reference
Learn how to use the Typecast API
Models
Learn about ssfm-v30 and ssfm-v21 models
Changelog
See the latest API changes and updates
Overview
Models
github
linkedin
youtube
website

heres the api: `YOUR_TYPECAST_API_KEY`

heres the voice id i want to use: tc_632a759503f3cb7b9c8a717b

use the new tts system and remove the old utsumunes tts system
