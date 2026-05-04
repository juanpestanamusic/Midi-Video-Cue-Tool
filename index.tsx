/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// --- Type Definitions for YouTube IFrame API ---
declare global {
  interface Window {
    onYouTubeIframeAPIReady: () => void;
  }
  namespace YT {
    class Player {
      constructor(
        elementId: string,
        options: {
          height?: string;
          width?: string;
          videoId?: string;
          playerVars?: YT.PlayerVars;
          events?: YT.Events;
        },
      );
      playVideo(): void;
      pauseVideo(): void;
      seekTo(seconds: number, allowSeekAhead: boolean): void;
      getCurrentTime(): number;
      loadVideoById(videoId: string): void;
      getIframe(): HTMLIFrameElement;
    }

    interface PlayerVars {
      autoplay?: 0 | 1;
      controls?: 0 | 1 | 2;
      playsinline?: 0 | 1;
    }

    interface Events {
      onReady?: (event: { target: YT.Player }) => void;
    }
  }
}

// --- Constants & Global DOM References ---
const NUM_PLAYERS = 4;
// A fresh list of reliable, public Invidious instances for search resilience.
const INVIDIOUS_INSTANCES = [
    'https://invidious.nerdvpn.de',
    'https://invidious.privacydev.net',
    'https://inv.hnh.is',
    'https://invidious.kavin.rocks',
    'https://yt.funami.tech',
    'https://vid.puffyan.us', 
];
const midiSelect = document.getElementById('midi-select') as HTMLSelectElement;
const midiStatus = document.getElementById('midi-status') as HTMLDivElement;
const playersContainer = document.getElementById('players-container') as HTMLElement;
const playerTemplate = document.getElementById('player-template') as HTMLTemplateElement;

// --- State Management ---
interface PlayerState {
  id: number;
  player: YT.Player | null;
  cuePoints: Map<number, number>; // Map<MIDI note number, video time in seconds>
  isGateModeEnabled: boolean;
  isLoopModeEnabled: boolean;
  loopStart: number | null;
  loopEnd: number | null;
  isSettingLoop: boolean;
  loopingNote: number | null;
  loopAnimationId: number | null;
  activeGateNote: number | null; // Tracks the note for gated playback

  // UI Elements for this player instance
  elements: {
    instance: HTMLElement;
    videoUrlInput: HTMLInputElement;
    loadVideoBtn: HTMLButtonElement;
    mapMidiBtn: HTMLButtonElement;
    gateModeToggle: HTMLInputElement;
    loopModeToggle: HTMLInputElement;
    loopStartContainer: HTMLDivElement;
    loopEndContainer: HTMLDivElement;
    loopStartDisplay: HTMLSpanElement;
    loopEndDisplay: HTMLSpanElement;
    loopStartInput: HTMLInputElement;
    loopEndInput: HTMLInputElement;
    clearLoopBtn: HTMLButtonElement;
    cueList: HTMLUListElement;
    searchResultsContainer: HTMLDivElement;
  };
}

let playerStates: PlayerState[] = [];
let activeMidiInput: MIDIInput | null = null;
let activeMappingPlayerId: number | null = 0; // Default to the first player

/**
 * Shuffles an array in place using the Fisher-Yates algorithm.
 * @param array An array containing the items.
 */
function shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * Parses a YouTube video ID from various URL formats.
 */
function getYouTubeId(url: string): string | null {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|\/shorts\/)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

/**
 * Renders the search results in the player's UI.
 */
function renderSearchResults(results: any[], playerId: number) {
    const state = playerStates[playerId];
    const { elements } = state;
    elements.searchResultsContainer.innerHTML = '';

    if (results.length === 0) {
        elements.searchResultsContainer.innerHTML = `<div class="search-error">No videos found.</div>`;
        return;
    }

    results.forEach(video => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.setAttribute('aria-label', `Load video: ${video.title}`);
        item.innerHTML = `
            <img src="${video.thumbnail}" alt="" class="search-result-thumb" loading="lazy">
            <div class="search-result-info">
                <span class="search-result-title" title="${video.title}">${video.title}</span>
                <span class="search-result-channel">${video.channelName}</span>
            </div>
        `;
        
        item.addEventListener('click', () => {
            if (state.player) {
                state.player.loadVideoById(video.videoId);
                elements.videoUrlInput.value = `https://www.youtube.com/watch?v=${video.videoId}`;
            }
            elements.searchResultsContainer.style.display = 'none';
            elements.searchResultsContainer.innerHTML = '';
        });
        elements.searchResultsContainer.appendChild(item);
    });
}

/**
 * Performs a search on YouTube and renders the results.
 */
async function performSearch(query: string, playerId: number) {
    const state = playerStates[playerId];
    const { elements } = state;

    elements.searchResultsContainer.style.display = 'block';
    elements.searchResultsContainer.innerHTML = '<div class="loader"></div>';

    // Create a shuffled list of instances to try for this search attempt.
    const shuffledInstances = shuffleArray([...INVIDIOUS_INSTANCES]);

    for (const instance of shuffledInstances) {
        try {
            const searchUrl = `${instance}/api/v1/search?type=video&q=${encodeURIComponent(query)}`;
            
            // Fetch with a timeout to avoid getting stuck on a slow instance
            const response = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });

            if (!response.ok) {
                console.warn(`Search failed on ${instance} (status: ${response.status}). Trying next instance.`);
                continue; // Try the next one
            }

            const data = await response.json();
            
            // Map Invidious API response and filter for valid entries
            const results = (data as any[])
                .map((video: any) => ({
                    videoId: video.videoId,
                    title: video.title,
                    thumbnail: video.videoThumbnails?.find((t: any) => t.quality === 'hqdefault')?.url || video.videoThumbnails?.[0]?.url,
                    channelName: video.author,
                }))
                .filter(video => video.videoId && video.title && video.thumbnail && video.channelName);
            
            if (results.length > 0) {
                renderSearchResults(results, playerId);
                return; // Success! Exit the function.
            } else {
                console.warn(`No valid results from ${instance}. Trying next instance.`);
            }

        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                 console.warn(`Search timed out on ${instance}. Trying next instance.`);
            } else {
                 console.error(`Search failed on ${instance}:`, error);
            }
            // Continue to the next instance in the loop
        }
    }
    
    // This part is reached only if all instances fail
    console.error('YouTube search failed on all available instances.');
    elements.searchResultsContainer.innerHTML = `<div class="search-error">Could not fetch results. Please try a different search or try again later.</div>`;
}


/**
 * Loads a video for a specific player.
 */
function loadVideo(url: string, playerId: number) {
    const videoId = getYouTubeId(url);
    const state = playerStates[playerId];

    if (!videoId) {
        alert("Invalid YouTube URL. Please provide a valid video link (e.g., from youtube.com or youtu.be).");
        return;
    }

    if (state.player && typeof state.player.loadVideoById === 'function') {
        state.player.loadVideoById(videoId);
    }
}

/**
 * Formats time in seconds to a MM:SS.ms string.
 */
function formatTime(timeInSeconds: number): string {
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const milliseconds = Math.floor((timeInSeconds * 1000) % 1000);

    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(seconds).padStart(2, '0');
    const paddedMilliseconds = String(milliseconds).padStart(3, '0');

    return `${paddedMinutes}:${paddedSeconds}.${paddedMilliseconds}`;
}

/**
 * Parses a time string in MM:SS.ms format into seconds.
 */
function parseTime(timeString: string): number | null {
    const timeRegex = /^(?:(\d{1,2}):)?(\d{1,2})(?:\.(\d{1,3}))?$/;
    const match = timeString.match(timeRegex);

    if (!match) return null;

    const minutes = parseInt(match[1] || '0', 10);
    const seconds = parseInt(match[2] || '0', 10);
    const milliseconds = parseInt((match[3] || '0').padEnd(3, '0'), 10);

    if (isNaN(minutes) || isNaN(seconds) || isNaN(milliseconds) || seconds >= 60 || minutes >= 60) {
        return null;
    }

    return minutes * 60 + seconds + milliseconds / 1000;
}

/**
 * Updates the loop points display in the UI for a specific player.
 */
function updateLoopUI(playerId: number) {
    const state = playerStates[playerId];
    const { elements, loopStart, loopEnd } = state;
    const startText = loopStart !== null ? formatTime(loopStart) : '--:--.---';
    elements.loopStartDisplay.textContent = startText;
    elements.loopStartInput.value = startText;

    const endText = loopEnd !== null ? formatTime(loopEnd) : '--:--.---';
    elements.loopEndDisplay.textContent = endText;
    elements.loopEndInput.value = endText;
}

/**
 * Checks video time and loops if necessary. Runs on requestAnimationFrame for a specific player.
 */
function checkLoop(playerId: number) {
    const state = playerStates[playerId];
    if (!state.player || state.loopStart === null || state.loopEnd === null) {
        state.loopAnimationId = null;
        return;
    }
    if (state.player.getCurrentTime() >= state.loopEnd) {
        state.player.seekTo(state.loopStart, true);
    }
    state.loopAnimationId = requestAnimationFrame(() => checkLoop(playerId));
}

/**
 * Centralized function to manage loop state changes for a specific player.
 */
function updateLoopState(playerId: number) {
    const state = playerStates[playerId];
    // 1. Ensure start < end
    if (state.loopStart !== null && state.loopEnd !== null && state.loopStart > state.loopEnd) {
        [state.loopStart, state.loopEnd] = [state.loopEnd, state.loopStart];
    }

    // 2. Update the UI
    updateLoopUI(playerId);

    // 3. Manage the animation frame loop
    const isLoopValid = state.loopStart !== null && state.loopEnd !== null;
    if (isLoopValid && !state.loopAnimationId) {
        checkLoop(playerId);
    } else if (!isLoopValid && state.loopAnimationId) {
        cancelAnimationFrame(state.loopAnimationId);
        state.loopAnimationId = null;
    }
}

/**
 * Clears the current loop for a specific player.
 */
function clearLoop(playerId: number) {
    const state = playerStates[playerId];
    if (state.loopAnimationId) {
        cancelAnimationFrame(state.loopAnimationId);
        state.loopAnimationId = null;
    }
    state.loopStart = null;
    state.loopEnd = null;
    state.isSettingLoop = false;
    state.loopingNote = null;
    updateLoopUI(playerId);
}

/**
 * Renders the list of cue points in the UI for a specific player.
 */
function renderCuePoints(playerId: number) {
    const state = playerStates[playerId];
    const { cueList } = state.elements;
    cueList.innerHTML = ''; // Clear existing list

    if (state.cuePoints.size === 0) {
        cueList.innerHTML = `<li class="placeholder">Activate and press a MIDI note to create a cue point.</li>`;
        return;
    }

    const sortedCues = Array.from(state.cuePoints.entries()).sort((a, b) => a[1] - b[1]);

    for (const [note, time] of sortedCues) {
        const listItem = document.createElement('li');
        listItem.setAttribute('aria-label', `Cue point for MIDI note ${note} at ${formatTime(time)}`);
        const timeContainer = setupEditableTime(note, time, playerId, () => renderCuePoints(playerId));

        const cueInfoDiv = document.createElement('div');
        cueInfoDiv.className = 'cue-info';
        
        const cueNoteSpan = document.createElement('span');
        cueNoteSpan.className = 'cue-note';
        cueNoteSpan.textContent = `Note: ${note}`;

        cueInfoDiv.appendChild(cueNoteSpan);
        cueInfoDiv.appendChild(timeContainer);
        
        const cueActionsDiv = document.createElement('div');
        cueActionsDiv.className = 'cue-actions';

        const jumpBtn = document.createElement('button');
        jumpBtn.className = 'jump-btn';
        jumpBtn.title = 'Jump to cue point';
        jumpBtn.textContent = 'Jump';
        jumpBtn.addEventListener('click', () => {
            if (state.player) {
                state.player.seekTo(time, true);
                state.player.playVideo();
            }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.title = 'Delete cue point';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.cuePoints.delete(note);
            renderCuePoints(playerId);
        });

        cueActionsDiv.appendChild(jumpBtn);
        cueActionsDiv.appendChild(deleteBtn);
        listItem.appendChild(cueInfoDiv);
        listItem.appendChild(cueActionsDiv);
        cueList.appendChild(listItem);
    }
}

/**
 * Handles incoming MIDI messages, routing them based on mode (mapping vs. playback).
 */
function handleMidiMessage(event: MIDIMessageEvent) {
    const [command, note, velocity] = event.data;
    const isNoteOn = command >= 144 && command <= 159 && velocity > 0;
    const isNoteOff = (command >= 128 && command <= 143) || (command >= 144 && command <= 159 && velocity === 0);

    // --- MAPPING MODE ---
    // If a player is selected for mapping, all MIDI events are routed to it.
    if (activeMappingPlayerId !== null) {
        const state = playerStates[activeMappingPlayerId];
        if (!state.player || typeof state.player.getCurrentTime !== 'function') return;

        if (isNoteOn) {
            // In mapping mode, gate mode logic is simplified: just play. Note-off will pause.
            state.activeGateNote = note; 

            if (state.isLoopModeEnabled) {
                // Start setting a new loop
                clearLoop(state.id);
                state.isSettingLoop = true;
                state.loopingNote = note;
                state.loopStart = state.player.getCurrentTime();
                updateLoopUI(state.id);
            } else if (state.cuePoints.has(note)) {
                // Trigger an existing cue point
                const time = state.cuePoints.get(note)!;
                state.player.seekTo(time, true);
                state.player.playVideo();
            } else {
                // Create a new cue point
                const currentTime = state.player.getCurrentTime();
                state.cuePoints.set(note, currentTime);
                renderCuePoints(state.id);
            }
        } else if (isNoteOff) {
            if (state.isLoopModeEnabled && state.isSettingLoop && note === state.loopingNote) {
                // Finish setting a loop
                state.loopEnd = state.player.getCurrentTime();
                state.isSettingLoop = false;
                state.loopingNote = null;
                updateLoopState(state.id);
            } else if (state.isGateModeEnabled && state.activeGateNote === note) {
                // Pause video on note-off in gate mode
                state.player.pauseVideo();
                state.activeGateNote = null;
            }
        }
    } 
    // --- PLAYBACK MODE ---
    // If no player is selected, MIDI notes trigger existing cues across all players.
    // Cue creation and looping are disabled.
    else {
        if (isNoteOn) {
            playerStates.forEach(state => {
                if (state.player && state.cuePoints.has(note)) {
                    const time = state.cuePoints.get(note)!;
                    state.player.seekTo(time, true);
                    state.player.playVideo();
                    if (state.isGateModeEnabled) {
                        state.activeGateNote = note;
                    }
                }
            });
        } else if (isNoteOff) {
            playerStates.forEach(state => {
                if (state.player && state.isGateModeEnabled && state.activeGateNote === note) {
                    state.player.pauseVideo();
                    state.activeGateNote = null;
                }
            });
        }
    }
}

/**
 * Sets the active MIDI input device and attaches the message handler.
 */
function setActiveMidiInput(midiAccess: MIDIAccess, inputId: string | null) {
    if (activeMidiInput) activeMidiInput.onmidimessage = null;
    activeMidiInput = inputId ? midiAccess.inputs.get(inputId) ?? null : null;

    if (activeMidiInput) {
        activeMidiInput.onmidimessage = handleMidiMessage;
        midiStatus.textContent = `Status: Connected to ${activeMidiInput.name}`;
        midiStatus.classList.add('connected');
    } else {
        midiStatus.textContent = 'Status: Disconnected';
        midiStatus.classList.remove('connected');
    }
}

/**
 * Initializes the MIDI system.
 */
async function setupMidi() {
    try {
        if (!navigator.requestMIDIAccess) {
            midiStatus.textContent = 'Web MIDI API not supported in this browser.';
            midiSelect.disabled = true;
            return;
        }

        const midiAccess = await navigator.requestMIDIAccess({ sysex: false });

        const populateDevices = () => {
            if (midiAccess.inputs.size > 0) {
                midiSelect.innerHTML = '';
                const currentSelection = midiSelect.value;
                midiAccess.inputs.forEach((input) => {
                    const option = document.createElement('option');
                    option.value = input.id;
                    option.textContent = input.name;
                    midiSelect.appendChild(option);
                });
                
                const iacDriver = Array.from(midiAccess.inputs.values()).find(input => input.name?.toLowerCase().includes('iac driver'));
                if (currentSelection && Array.from(midiSelect.options).some(o => o.value === currentSelection)) {
                    midiSelect.value = currentSelection;
                } else if (iacDriver) {
                    midiSelect.value = iacDriver.id;
                }
                
                setActiveMidiInput(midiAccess, midiSelect.value);
                midiSelect.disabled = false;
            } else {
                midiSelect.innerHTML = '<option>No MIDI devices found</option>';
                midiSelect.disabled = true;
                setActiveMidiInput(midiAccess, null);
            }
        };
        
        populateDevices();
        midiAccess.onstatechange = populateDevices;
        midiSelect.addEventListener('change', () => setActiveMidiInput(midiAccess, midiSelect.value));
    } catch (error) {
        console.error('Could not access MIDI devices.', error);
        midiStatus.textContent = 'Failed to access MIDI devices.';
    }
}

/**
 * Creates all YT.Player instances when the API is ready.
 */
window.onYouTubeIframeAPIReady = () => {
    playerStates.forEach((state, i) => {
        const playerOptions: {
            height: string;
            width: string;
            videoId?: string;
            playerVars: YT.PlayerVars;
            events: YT.Events;
        } = {
            height: '100%',
            width: '100%',
            playerVars: { 'controls': 1, 'playsinline': 1 }, // No autoplay here
            events: { 'onReady': (event) => onPlayerReady(event, i) },
        };

        // Set video only for the first player initially
        if (i === 0) {
            playerOptions.videoId = 'LXb3EKWsInQ';
        }

        state.player = new YT.Player(`youtube-player-${i}`, playerOptions);
    });
};

/**
 * Called when a specific player is ready.
 */
function onPlayerReady(event: { target: YT.Player }, playerId: number) {
    // Autoplay the first video when it's ready. This is now the single source
    // of truth for initial playback, replacing the 'autoplay' playerVar.
    if (playerId === 0) {
        event.target.playVideo();
    }
    const iframe = playerStates[playerId].player?.getIframe();
    if (iframe) {
        // This ensures the iframe respects the container's border-radius
        iframe.style.borderRadius = '8px 8px 0 0';
    }
}


/**
 * Creates an editable time field for cue points.
 */
function setupEditableTime(note: number, time: number, playerId: number, onSaveCallback: () => void) {
    const timeContainer = document.createElement('div');
    timeContainer.className = 'cue-time';
    timeContainer.title = "Click to edit time";
    
    const timeDisplay = document.createElement('span');
    timeDisplay.className = 'cue-time-display';
    timeDisplay.textContent = formatTime(time);

    const timeInput = document.createElement('input');
    timeInput.type = 'text';
    timeInput.className = 'cue-time-input';
    timeInput.value = formatTime(time);
    timeInput.style.display = 'none';

    const save = () => {
        const newTime = parseTime(timeInput.value);
        if (newTime !== null && newTime >= 0) {
            playerStates[playerId].cuePoints.set(note, newTime);
        }
        onSaveCallback();
    };

    timeContainer.addEventListener('click', () => {
        timeDisplay.style.display = 'none';
        timeInput.style.display = 'inline-block';
        timeInput.focus();
        timeInput.select();
    });
    timeInput.addEventListener('blur', save);
    timeInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') timeInput.blur();
        if (e.key === 'Escape') {
            timeInput.value = formatTime(time);
            timeInput.blur();
        }
    });

    timeContainer.appendChild(timeDisplay);
    timeContainer.appendChild(timeInput);
    return timeContainer;
}

/**
 * Updates the visual selection for which player is active for MIDI mapping.
 */
function updateMappingSelection(newPlayerId: number | null) {
    activeMappingPlayerId = newPlayerId;
    playerStates.forEach(state => {
        const isActive = state.id === newPlayerId;
        state.elements.instance.classList.toggle('active-mapping', isActive);
        state.elements.mapMidiBtn.classList.toggle('active-mapping', isActive);
    });
}

/**
 * Initializes the application.
 */
function main() {
    for (let i = 0; i < NUM_PLAYERS; i++) {
        const clone = playerTemplate.content.cloneNode(true) as DocumentFragment;
        
        // Query for all elements within the cloned template
        const elements = {
            instance: clone.querySelector('.player-instance') as HTMLElement,
            videoUrlInput: clone.querySelector('.video-url-input') as HTMLInputElement,
            loadVideoBtn: clone.querySelector('.load-video-btn') as HTMLButtonElement,
            mapMidiBtn: clone.querySelector('.map-midi-btn') as HTMLButtonElement,
            gateModeToggle: clone.querySelector('.gate-mode-toggle') as HTMLInputElement,
            loopModeToggle: clone.querySelector('.loop-mode-toggle') as HTMLInputElement,
            loopStartContainer: clone.querySelector('.loop-start-container') as HTMLDivElement,
            loopEndContainer: clone.querySelector('.loop-end-container') as HTMLDivElement,
            loopStartDisplay: clone.querySelector('.loop-start-display') as HTMLSpanElement,
            loopEndDisplay: clone.querySelector('.loop-end-display') as HTMLSpanElement,
            loopStartInput: clone.querySelector('.loop-start-input') as HTMLInputElement,
            loopEndInput: clone.querySelector('.loop-end-input') as HTMLInputElement,
            clearLoopBtn: clone.querySelector('.clear-loop-btn') as HTMLButtonElement,
            cueList: clone.querySelector('.cue-list') as HTMLUListElement,
            playerContainer: clone.querySelector('.youtube-player-container') as HTMLDivElement,
            playerTitle: clone.querySelector('.player-title') as HTMLHeadingElement,
            searchResultsContainer: clone.querySelector('.search-results') as HTMLDivElement,
        };

        elements.playerTitle.textContent = `Player ${i + 1}`;
        elements.instance.dataset.playerId = i.toString();
        elements.playerContainer.id = `youtube-player-${i}`;
        if (i===0) elements.videoUrlInput.value = "https://www.youtube.com/watch?v=LXb3EKWsInQ";

        // Create state object
        const state: PlayerState = {
            id: i, player: null, cuePoints: new Map(), isGateModeEnabled: false, isLoopModeEnabled: false,
            loopStart: null, loopEnd: null, isSettingLoop: false, loopingNote: null, loopAnimationId: null, 
            activeGateNote: null, elements
        };
        playerStates.push(state);

        // Add event listeners
        const handleSearchOrLoad = () => {
            const query = elements.videoUrlInput.value.trim();
            if (!query) return;
            const videoId = getYouTubeId(query);
            if (videoId) {
                if (state.player) state.player.loadVideoById(videoId);
                elements.searchResultsContainer.style.display = 'none';
                elements.searchResultsContainer.innerHTML = '';
            } else {
                performSearch(query, i);
            }
        };
        elements.loadVideoBtn.addEventListener('click', handleSearchOrLoad);
        elements.videoUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearchOrLoad(); });

        elements.mapMidiBtn.addEventListener('click', () => {
            // If this player is already active, deselect it (set to null). Otherwise, select it.
            const newPlayerId = activeMappingPlayerId === i ? null : i;
            updateMappingSelection(newPlayerId);
        });
        elements.gateModeToggle.addEventListener('change', () => {
            state.isGateModeEnabled = elements.gateModeToggle.checked;
            if (state.isGateModeEnabled) {
                elements.loopModeToggle.checked = false;
                state.isLoopModeEnabled = false;
                clearLoop(i);
            } else {
                state.activeGateNote = null; // Clear any tracked note when turning mode off
            }
        });
        elements.loopModeToggle.addEventListener('change', () => {
            state.isLoopModeEnabled = elements.loopModeToggle.checked;
            if (state.isLoopModeEnabled) {
                elements.gateModeToggle.checked = false;
                state.isGateModeEnabled = false;
                state.activeGateNote = null;
            } else {
                clearLoop(i);
            }
        });
        elements.clearLoopBtn.addEventListener('click', () => clearLoop(i));

        const setupTimeEdit = (container: HTMLElement, displayEl: HTMLElement, inputEl: HTMLInputElement, isStart: boolean) => {
            container.addEventListener('click', (e) => {
                if (e.target !== inputEl) {
                    displayEl.style.display = 'none';
                    inputEl.style.display = 'inline-block';
                    inputEl.focus(); inputEl.select();
                }
            });
            const save = () => {
                const newTime = parseTime(inputEl.value);
                if (isStart) state.loopStart = newTime; else state.loopEnd = newTime;
                updateLoopState(i);
                inputEl.style.display = 'none';
                displayEl.style.display = 'inline-block';
            };
            inputEl.addEventListener('blur', save);
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') inputEl.blur();
                if (e.key === 'Escape') {
                    inputEl.value = displayEl.textContent || '';
                    inputEl.blur();
                }
            });
        };

        setupTimeEdit(elements.loopStartContainer, elements.loopStartDisplay, elements.loopStartInput, true);
        setupTimeEdit(elements.loopEndContainer, elements.loopEndDisplay, elements.loopEndInput, false);

        // Initial UI state
        renderCuePoints(i);
        updateLoopUI(i);
        
        playersContainer.appendChild(clone);
    }

    // Global listener to hide search results when clicking outside
    document.addEventListener('click', (e) => {
        playerStates.forEach(state => {
            const searchContainer = state.elements.instance.querySelector('.search-container');
            if (searchContainer && !searchContainer.contains(e.target as Node)) {
                state.elements.searchResultsContainer.style.display = 'none';
            }
        });
    });

    setupMidi();
    updateMappingSelection(0); // Set first player as active initially
}

document.addEventListener('DOMContentLoaded', main);
export {};