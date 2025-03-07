import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Button, 
  TextField, 
  Switch, 
  Typography, 
  Container, 
  Grid, 
  List, 
  ListItem, 
  IconButton, 
  Snackbar, 
  Alert, 
  Paper, 
  Box,
  Checkbox,
  Chip,
  CircularProgress
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import MicIcon from '@mui/icons-material/Mic';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import OpenAI from 'openai';
import ReactMarkdown from 'react-markdown';
import SettingsDialog from '../components/SettingsDialog';
import { getConfig } from '../utils/config';
import { useDispatch, useSelector } from 'react-redux';
import { setTranscription, clearTranscription } from '../redux/transcriptionSlice';
import { setAIResponse } from '../redux/aiResponseSlice';
import { addToHistory } from '../redux/historySlice';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { GoogleGenerativeAI } from '@google/generative-ai';
import throttle from 'lodash.throttle';


export default function Home() {
  const dispatch = useDispatch();
  const transcription = useSelector(state => state.transcription);
  const aiResponse = useSelector(state => state.aiResponse);
  const history = useSelector(state => state.history);

  // State variables
  const [systemRecognizer, setSystemRecognizer] = useState(null);
  const [micRecognizer, setMicRecognizer] = useState(null);
  const [systemAutoMode, setSystemAutoMode] = useState(true);
  const [openAI, setOpenAI] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isMicrophoneActive, setIsMicrophoneActive] = useState(false);
  const [isSystemAudioActive, setIsSystemAudioActive] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState('info');
  const [selectedQuestions, setSelectedQuestions] = useState([]);
  const [isManualMode, setIsManualMode] = useState(false);
  const [micTranscription, setMicTranscription] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAILoading, setIsAILoading] = useState(true);
  
  // Refs
  const systemInterimTranscription = useRef('');
  const micInterimTranscription = useRef('');
  const silenceTimer = useRef(null);
  const finalTranscript = useRef({ system: '', microphone: '' });
  const isManualModeRef = useRef(isManualMode);
  const systemAutoModeRef = useRef(systemAutoMode);
  const responseEndRef = useRef(null);

  const [autoScroll, setAutoScroll] = useState(false); 
  // Add config state
  const [config, setConfig] = useState(getConfig());

  const handleSettingsSaved = () => {
    setConfig(getConfig());
  };

  // Config initialization
  useEffect(() => {
    const scrollToBottom = () => {
      if (autoScroll && responseEndRef.current) {
        responseEndRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }
    };
  
    // Throttle scrolling to 100ms
    const throttledScroll = throttle(scrollToBottom, 100);
    throttledScroll();
    
    return () => throttledScroll.cancel();
  }, [aiResponse, autoScroll]);

  useEffect(() => {
    const initializeAI = () => {
      try {
        setIsAILoading(true);
        if (config.aiModel.startsWith('gemini')) {
          if (!config.geminiKey) {
            showSnackbar('Gemini API key required for selected model', 'error');
            return;
          }
          const genAI = new GoogleGenerativeAI(config.geminiKey);
          setOpenAI(genAI);
        } else {
          if (!config.openaiKey) {
            showSnackbar('OpenAI API key required for selected model', 'error');
            return;
          }
          const openaiClient = new OpenAI({
            apiKey: config.openaiKey,
            dangerouslyAllowBrowser: true
          });
          setOpenAI(openaiClient);
        }
      } catch (error) {
        showSnackbar('Error initializing AI client', 'error');
      } finally {
        setIsAILoading(false);
      }
    };
    initializeAI();
  }, [config.aiModel, config.geminiKey, config.openaiKey]);

  // Update refs when state changes
  useEffect(() => { isManualModeRef.current = isManualMode; }, [isManualMode]);
  useEffect(() => { systemAutoModeRef.current = systemAutoMode; }, [systemAutoMode]);

  // Snackbar controls
  const showSnackbar = useCallback((message, severity = 'info') => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  }, []);

  const handleSnackbarClose = () => setSnackbarOpen(false);

  // Audio controls
  const stopRecording = async (source) => {
    const recognizer = source === 'system' ? systemRecognizer : micRecognizer;
    if (recognizer) {
      try {
        if (recognizer instanceof SpeechSDK.SpeechRecognizer) {
          await recognizer.stopContinuousRecognitionAsync();
          // Close the underlying media stream
          const stream = recognizer.audioConfig.stream;
          if (stream instanceof MediaStream) { // Changed to MediaStream
            stream.getTracks().forEach(track => track.stop());
          }
        }
      } catch (error) {
        console.error('Error stopping recognition:', error);
      } finally {
        if (source === 'system') {
          setIsSystemAudioActive(false);
          setSystemRecognizer(null);
        } else {
          setIsMicrophoneActive(false);
          setMicRecognizer(null);
        }
      }
    }
  };

  // Transcription handlers
  const handleClearSystem = () => {
    finalTranscript.current.system = '';
    systemInterimTranscription.current = '';
    dispatch(clearTranscription());
  };

  const handleTranscription = (text, source) => {
    const cleanText = text.replace(/\s+/g, ' ').trim();
    if (!cleanText) return;
  
    // Only append if in manual mode for microphone, or always for system (if auto mode enabled)
    finalTranscript.current[source] += cleanText + ' ';
  
    if (source === 'system') {
      dispatch(setTranscription(finalTranscript.current.system + systemInterimTranscription.current));
    } else {
      setMicTranscription(finalTranscript.current.microphone + micInterimTranscription.current);
    }
  
    if ((source === 'system' && systemAutoModeRef.current) || 
        (source === 'microphone' && !isManualModeRef.current)) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = setTimeout(() => {
        askOpenAI(finalTranscript.current[source].trim(), source);
      }, config.silenceTimerDuration * 1000); // Convert seconds to milliseconds
    }
  };

  // Input handlers
  const handleManualInput = (value, source) => {
    const cleanValue = value.replace(/\s+/g, ' ').trim();
    finalTranscript.current[source] = cleanValue;
    source === 'system' ? dispatch(setTranscription(cleanValue)) : setMicTranscription(cleanValue);
  };

  const handleKeyPress = (e, source) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      source === 'system' 
        ? askOpenAI(transcription, 'system')
        : askOpenAI(micTranscription, 'microphone');
    }
  };

  // Question handling
  const handleCombineSubmit = () => {
    if (selectedQuestions.length === 0) {
      showSnackbar('No questions selected', 'warning');
      return;
    }
    
    const combinedText = selectedQuestions
      .map(index => history.filter(e => e.type === 'question')[index].text)
      .join('\n\n');
    
    askOpenAI(combinedText, 'combined');
    setSelectedQuestions([]);
  };

  // Recognition starters
  const startSystemRecognition = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true });
      await stopRecording('system');
      
      const config = getConfig();
      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(stream);
      const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(config.azureToken, config.azureRegion);
      speechConfig.speechRecognitionLanguage = config.azureLanguage;
      
      const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

      recognizer.recognizing = (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizingSpeech) {
          systemInterimTranscription.current = e.result.text;
          dispatch(setTranscription(finalTranscript.current.system + e.result.text));
        }
      };

      recognizer.recognized = (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
          systemInterimTranscription.current = '';
          handleTranscription(e.result.text, 'system');
        }
      };

      await recognizer.startContinuousRecognitionAsync();
      setSystemRecognizer(recognizer);
      setIsSystemAudioActive(true);
    } catch (error) {
      console.error('System audio error:', error);
      showSnackbar('Failed to start system audio', 'error');
    }
  };

  const startMicRecognition = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await stopRecording('microphone');
      
      const config = getConfig();
      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(stream);
      const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(config.azureToken, config.azureRegion);
      speechConfig.speechRecognitionLanguage = config.azureLanguage;
      
      const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

      recognizer.recognizing = (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizingSpeech) {
          micInterimTranscription.current = e.result.text;
          setMicTranscription(finalTranscript.current.microphone + e.result.text);
        }
      };

      recognizer.recognized = (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
          micInterimTranscription.current = '';
          handleTranscription(e.result.text, 'microphone');
        }
      };

      await recognizer.startContinuousRecognitionAsync();
      setMicRecognizer(recognizer);
      setIsMicrophoneActive(true);
    } catch (error) {
      console.error('Microphone error:', error);
      showSnackbar('Failed to access microphone', 'error');
    }
  };

  // OpenAI integration
  const askOpenAI = async (text, source) => {
    if (!text.trim()) {
      showSnackbar('No input text to process', 'warning');
      return;
    }
    
    if (!openAI) {
      showSnackbar('AI client is initializing, please wait...', 'warning');
      return;
    }
    // Add response length parameters
  const lengthSettings = {
    concise: { temperature: 0.5, maxTokens: 300 },
    medium: { temperature: 0.7, maxTokens: 600 },
    lengthy: { temperature: 0.9, maxTokens: 1200 }
  };

  const { temperature, maxTokens } = lengthSettings[config.responseLength || 'medium'];
  
    setIsProcessing(true);
    const timestamp = new Date().toLocaleTimeString();
    let fullResponse = '';
  
    try {
      dispatch(addToHistory({ 
        type: 'question', 
        text, 
        timestamp, 
        source,
        status: 'processing'
      }));
  
      // Clear previous response immediately
      dispatch(setAIResponse('(Generating response...)'));
  
      const conversationHistory = history
        .filter(e => e.status !== 'processing')
        .slice(-8)
        .map(event => ({
          role: event.type === 'question' ? 'user' : 'assistant',
          content: event.text,
          name: event.type === 'question' 
            ? (event.source === 'system' ? 'Interviewer' : 'Candidate') 
            : 'Assistant'
        }));
  
      if (config.aiModel.startsWith('gemini')) {
        const model = openAI.getGenerativeModel({ 
          model: config.aiModel,
          generationConfig: { 
            temperature,
            maxOutputTokens: maxTokens
          }
        });
        const chat = model.startChat({
          history: [
            { role: 'user', parts: [{ text: config.gptSystemPrompt }] },
            ...conversationHistory.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'model',
              parts: [{ text: msg.content }]
            }))
          ],
          generationConfig: { temperature: 0.7 }
        });
  
        const result = await chat.sendMessageStream(text);
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          fullResponse += chunkText;
          dispatch(setAIResponse(fullResponse));
        }
      } else {
        const messages = [
          { 
            role: 'system', 
            content: `${config.gptSystemPrompt}\nCurrent conversation context:\n${
              history.slice(-4)
                .map(e => `${e.type === 'question' ? 'Q' : 'A'}: ${e.text}`)
                .join('\n')
            }`
          },
          ...conversationHistory,
          { 
            role: 'user', 
            content: text,
            name: source === 'system' ? 'Interviewer' : 'Candidate'
          }
        ];
  
        const stream = await openAI.chat.completions.create({
          model: config.aiModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        });
  
        for await (const chunk of stream) {
          const chunkText = chunk.choices[0]?.delta?.content || '';
          fullResponse += chunkText;
          dispatch(setAIResponse(fullResponse));
        }
      }
  
      dispatch(addToHistory({ 
        type: 'response', 
        text: fullResponse, 
        timestamp: new Date().toLocaleTimeString(),
        context: conversationHistory
      }));
  
    } catch (error) {
      console.error("AI error:", error);
      showSnackbar("AI request failed: " + error.message, 'error');
      dispatch(setAIResponse('Error generating response'));
    } finally {
      if ((source === 'system' && systemAutoModeRef.current) ||
          (source === 'microphone' && !isManualModeRef.current)) {
        // Clear both the stored transcript and display state
        finalTranscript.current[source] = '';
        if (source === 'system') {
          systemInterimTranscription.current = '';
          dispatch(setTranscription(''));
        } else {
          micInterimTranscription.current = '';
          setMicTranscription('');
        }
      }
      setIsProcessing(false);
    }
  };

  // Response formatting
  const formatResponse = useCallback((response) => {
    if (!response) return null;
    
    return response.split(/(```[\s\S]*?```)/g).map((part, index) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const code = part.slice(3, -3).trim();
        const [lang, ...codeLines] = code.split('\n');
        const codeContent = codeLines.join('\n');
        return (
          <pre key={index} className="code-block">
            <code
              dangerouslySetInnerHTML={{
                __html: hljs.highlight(codeContent, { 
                  language: lang?.match(/^[\w-]+/)?.[0] || 'plaintext',
                  ignoreIllegals: true
                }).value
              }}
            />
          </pre>
        );
      }
      return (
        <ReactMarkdown 
          key={index}
          components={{
            strong: ({ node, ...props }) => <strong className="bold-text" {...props} />,
            em: ({ node, ...props }) => <em className="italic-text" {...props} />,
            p: ({ node, ...props }) => <Typography paragraph className="response-paragraph" {...props} />,
            code: ({ node, ...props }) => <code className="inline-code" {...props} />
          }}
        >
          {part}
        </ReactMarkdown>
      );
    });
  }, []);

  return (
    <Container maxWidth="xl" sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Interview Copilot : aicopilot.chat
        <IconButton 
          onClick={() => setSettingsOpen(true)} 
          sx={{ float: 'right' }}
          aria-label="settings"
        >
          <SettingsIcon />
        </IconButton>
      </Typography>

      <Grid container spacing={3}>
        {/* System Audio Panel */}
        <Grid item xs={12} md={3}>
          <Paper sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6">
                System Audio
                {isSystemAudioActive && <FiberManualRecordIcon color="error" sx={{ ml: 1, fontSize: 16 }} />}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Switch 
                  checked={systemAutoMode} 
                  onChange={e => setSystemAutoMode(e.target.checked)} 
                  size="small"
                  color="secondary"
                />
                <Typography variant="caption" sx={{ ml: 1 }}>Auto Ask</Typography>
              </Box>
            </Box>
            
            <TextField
              fullWidth
              multiline
              rows={4}
              value={transcription}
              onChange={(e) => handleManualInput(e.target.value, 'system')}
              onKeyDown={(e) => handleKeyPress(e, 'system')}
              sx={{ mb: 2 }}
              placeholder="System transcription will appear here..."
            />
            
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button 
                onClick={startSystemRecognition}
                variant="contained"
                color={isSystemAudioActive ? 'error' : 'primary'}
                startIcon={isSystemAudioActive ? null : <MicIcon />}
              >
                {isSystemAudioActive ? 'Stop System' : 'Start System'}
              </Button>
              <Button 
                onClick={handleClearSystem}
                variant="outlined"
                color="secondary"
              >
                Clear
              </Button>
              {!systemAutoMode && (
                <Button
                  onClick={() => askOpenAI(transcription, 'system')}
                  variant="contained"
                  color="secondary"
                  disabled={isProcessing}
                >
                  {isProcessing ? <CircularProgress size={24} /> : 'Submit'}
                </Button>
              )}
            </Box>
          </Paper>

          {/* Question History */}
          <Paper sx={{ p: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6">Question History</Typography>
              <Button 
                variant="contained" 
                onClick={handleCombineSubmit}
                disabled={selectedQuestions.length === 0 || isProcessing}
              >
                Combine & Ask
              </Button>
            </Box>
            <List sx={{ maxHeight: 300, overflow: 'auto' }}>
              {history.filter(e => e.type === 'question').slice().reverse().map((e, i) => (
                <ListItem key={i} dense>
                  <Checkbox
                    checked={selectedQuestions.includes(i)}
                    onChange={() => setSelectedQuestions(prev => 
                      prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i]
                    )}
                    size="small"
                    color="secondary"
                  />
                  <Box sx={{ width: '100%' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
                      <Chip 
                        label={e.timestamp} 
                        size="small" 
                        sx={{ mr: 1, bgcolor: 'secondary.light' }} 
                      />
                      <Typography variant="caption" color="text.secondary">
                        {e.source === 'system' ? 'Interviewer' : 'Candidate'}
                      </Typography>
                    </Box>
                    <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                      {e.text}
                    </Typography>
                  </Box>
                </ListItem>
              ))}
            </List>
          </Paper>
        </Grid>

        {/* Response Panel */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, height: '70vh', overflow: 'auto' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6">
                Current Response
                {isProcessing && <CircularProgress size={20} sx={{ ml: 2 }} />}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Switch 
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  size="small"
                  color="secondary"
                />
                <Typography variant="caption" sx={{ ml: 1 }}>Auto Scroll</Typography>
              </Box>
            </Box>
            
            <Box sx={{ whiteSpace: 'pre-wrap', minHeight: 200 }}>
  {formatResponse(aiResponse)}
  {isProcessing && (
    <CircularProgress size={20} sx={{ mt: 1 }} />
  )}
  <div ref={responseEndRef} />
</Box>
            
            <Typography variant="h6" gutterBottom sx={{ mt: 4 }}>
              Previous Responses
            </Typography>
            <List>
              {history.filter(e => e.type === 'response').reverse().map((e, i) => (
                <ListItem key={i} sx={{ flexDirection: 'column', alignItems: 'start' }}>
                  <Chip 
                    label={e.timestamp} 
                    size="small" 
                    sx={{ alignSelf: 'flex-start', mb: 1, bgcolor: 'success.light' }} 
                  />
                  <Box sx={{ 
                    backgroundColor: 'background.paper',
                    p: 2,
                    borderRadius: 1,
                    width: '100%',
                    boxShadow: 1
                  }}>
                    {formatResponse(e.text)}
                  </Box>
                </ListItem>
              ))}
            </List>
          </Paper>
        </Grid>

        {/* Microphone Panel */}
        <Grid item xs={12} md={3}>
          <Paper sx={{ p: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6">
                Microphone
                {isMicrophoneActive && <FiberManualRecordIcon color="error" sx={{ ml: 1, fontSize: 16 }} />}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Switch 
                  checked={isManualMode} 
                  onChange={e => setIsManualMode(e.target.checked)} 
                  size="small"
                  color="secondary"
                />
                <Typography variant="caption" sx={{ ml: 1 }}>Manual Mode</Typography>
              </Box>
            </Box>
            
            <Button
              variant="contained"
              color={isMicrophoneActive ? 'error' : 'primary'}
              startIcon={isMicrophoneActive ? null : <MicIcon />}
              onClick={isMicrophoneActive ? () => stopRecording('microphone') : startMicRecognition}
              fullWidth
              sx={{ mb: 2 }}
            >
              {isMicrophoneActive ? 'Stop Recording' : 'Start Microphone'}
            </Button>
            
            <TextField
              fullWidth
              multiline
              rows={4}
              value={micTranscription}
              onChange={(e) => handleManualInput(e.target.value, 'microphone')}
              onKeyDown={(e) => handleKeyPress(e, 'microphone')}
              sx={{ mb: 2 }}
              placeholder="Candidate transcription will appear here..."
            />
            
            {isManualMode && (
              <Button
                variant="contained"
                onClick={() => askOpenAI(micTranscription, 'microphone')}
                fullWidth
                disabled={isProcessing}
              >
                {isProcessing ? <CircularProgress size={24} /> : 'Submit Manual'}
              </Button>
            )}
          </Paper>
        </Grid>
      </Grid>

      <SettingsDialog 
  open={settingsOpen} 
  onClose={() => setSettingsOpen(false)}
  onSave={handleSettingsSaved}
/>
      <Snackbar open={snackbarOpen} autoHideDuration={6000} onClose={handleSnackbarClose}>
        <Alert severity={snackbarSeverity} sx={{ width: '100%' }}>
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Container>
  );
}