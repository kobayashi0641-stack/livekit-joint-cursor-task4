%% Cursor-control JSON to MAT converter
% Converts a recording JSON file into a MATLAB MAT file.
%
% Output variables:
%   recording  - analysis-friendly structure
%   raw        - complete result of jsondecode (nothing intentionally omitted)
%
% Usage:
%   1. Set inputJson below and run this script, or
%   2. Define inputJson/outputMat in the workspace before running it:
%        inputJson = "C:\path\recording.json";
%        outputMat = "C:\path\recording.mat";
%        run("convert_cursor_json_to_mat.m")

if ~exist('inputJson', 'var') || strlength(string(inputJson)) == 0
    inputJson = "C:\Users\owner\Downloads\2026-09-20T07-17-23_cursor-control-20260706_N2_2026-09-20T07-16-30_3-trials.json";
end

inputJson = string(inputJson);
assert(isfile(inputJson), 'JSON file not found: %s', inputJson);

if ~exist('outputMat', 'var') || strlength(string(outputMat)) == 0
    [inputDir, inputBase] = fileparts(inputJson);
    outputMat = fullfile(inputDir, inputBase + ".mat");
else
    outputMat = string(outputMat);
end

raw = jsondecode(fileread(inputJson));

recording = struct();
recording.sourceFile = char(inputJson);
recording.experimentName = getFieldOr(raw, 'experimentName', '');
recording.taskType = getFieldOr(raw, 'taskType', '');
recording.participantCount = getFieldOr(raw, 'participantCount', NaN);
recording.groupCount = getFieldOr(raw, 'groupCount', NaN);
recording.startTime = getFieldOr(raw, 'startTime', NaN);
recording.endTime = getFieldOr(raw, 'endTime', NaN);

trialItems = asCellItems(getFieldOr(raw, 'trials', []));
recording.trialCount = numel(trialItems);
trialResults = cell(recording.trialCount, 1);

% Questionnaire rows accumulated across all trials.
qTrial = [];
qTime = [];
qContribution = [];
qIdentity = {};
qKind = {};

for ti = 1:recording.trialCount
    srcTrial = trialItems{ti};
    dst = struct();

    dst.trialNumber = getFieldOr(srcTrial, 'trialNumber', ti);
    dst.startTime = getFieldOr(srcTrial, 'startTime', NaN);
    dst.endTime = getFieldOr(srcTrial, 'endTime', NaN);
    dst.frameRate = getFieldOr(srcTrial, 'frameRate', NaN);
    dst.displayMode = getFieldOr(srcTrial, 'displayMode', '');
    dst.roomName = getFieldOr(srcTrial, 'roomName', '');
    dst.taskType = getFieldOr(srcTrial, 'taskType', '');
    dst.experimentName = getFieldOr(srcTrial, 'experimentName', '');
    dst.trialMetadata = getFieldOr(srcTrial, 'trialMetadata', struct());
    dst.experimentConfig = getFieldOr(srcTrial, 'experimentConfig', struct());
    dst.groupAssignments = getFieldOr(srcTrial, 'groupAssignments', struct());

    if isstruct(dst.trialMetadata) && isfield(dst.trialMetadata, 'phase')
        dst.phase = dst.trialMetadata.phase;
    else
        dst.phase = '';
    end

    frameItems = asCellItems(getFieldOr(srcTrial, 'frames', []));
    nFrames = numel(frameItems);
    dst.frameCount = nFrames;
    dst.timestamp = nan(nFrames, 1);       % Unix epoch milliseconds
    dst.timeSeconds = nan(nFrames, 1);     % Relative to first valid timestamp
    dst.frameNumber = nan(nFrames, 1);
    dst.targetXY = nan(nFrames, 2);
    dst.averageXY = nan(nFrames, 2);

    % Build a stable participant list from every frame.
    identities = {};
    displayNames = {};
    for fi = 1:nFrames
        cursorItems = asCellItems(getFieldOr(frameItems{fi}, 'cursors', []));
        for ci = 1:numel(cursorItems)
            identity = char(string(getFieldOr(cursorItems{ci}, 'identity', '')));
            if isempty(identity)
                continue
            end
            idx = find(strcmp(identities, identity), 1);
            if isempty(idx)
                identities{end+1} = identity; %#ok<SAGROW>
                displayNames{end+1} = char(string(getFieldOr(cursorItems{ci}, 'displayName', ''))); %#ok<SAGROW>
            end
        end
    end

    nParticipants = numel(identities);
    dst.participantIdentities = identities;
    dst.participantDisplayNames = displayNames;
    dst.cursorXY = nan(nFrames, nParticipants, 2);
    dst.cursorRTTms = nan(nFrames, nParticipants);
    dst.participantTargetXY = nan(nFrames, nParticipants, 2);

    for fi = 1:nFrames
        frame = frameItems{fi};
        dst.timestamp(fi) = numericScalar(getFieldOr(frame, 'timestamp', NaN));
        dst.frameNumber(fi) = numericScalar(getFieldOr(frame, 'frameNumber', NaN));
        dst.targetXY(fi, :) = readXY(getFieldOr(frame, 'target', []));
        dst.averageXY(fi, :) = readXY(getFieldOr(frame, 'average', []));

        cursorItems = asCellItems(getFieldOr(frame, 'cursors', []));
        for ci = 1:numel(cursorItems)
            cursor = cursorItems{ci};
            identity = char(string(getFieldOr(cursor, 'identity', '')));
            pi = find(strcmp(identities, identity), 1);
            if isempty(pi)
                continue
            end
            dst.cursorXY(fi, pi, :) = reshape(readXY(cursor), 1, 1, 2);
            dst.cursorRTTms(fi, pi) = numericScalar(getFieldOr(cursor, 'rttMs', NaN));
        end

        participantTargets = getFieldOr(frame, 'participantTargets', struct());
        if isstruct(participantTargets)
            for pi = 1:nParticipants
                % jsondecode converts UUID object keys to valid MATLAB names.
                matlabKey = matlab.lang.makeValidName(identities{pi});
                if isfield(participantTargets, matlabKey)
                    dst.participantTargetXY(fi, pi, :) = ...
                        reshape(readXY(participantTargets.(matlabKey)), 1, 1, 2);
                end
            end
        end
    end

    validTime = find(isfinite(dst.timestamp), 1, 'first');
    if ~isempty(validTime)
        dst.timeSeconds = (dst.timestamp - dst.timestamp(validTime)) / 1000;
    end

    % Keep every event and extract shared-trial questionnaire answers.
    dst.events = getFieldOr(srcTrial, 'events', []);
    eventItems = asCellItems(dst.events);
    for ei = 1:numel(eventItems)
        event = eventItems{ei};
        eventType = char(string(getFieldOr(event, 'type', '')));
        if strcmp(eventType, 'sharedCursorResponse')
            qTrial(end+1, 1) = numericScalar(getFieldOr(event, 'trialNumber', dst.trialNumber)); %#ok<SAGROW>
            qTime(end+1, 1) = numericScalar(getFieldOr(event, 'timestamp', NaN)); %#ok<SAGROW>
            qContribution(end+1, 1) = numericScalar(getFieldOr(event, 'contribution', NaN)); %#ok<SAGROW>
            qIdentity{end+1, 1} = char(string(getFieldOr(event, 'identity', ''))); %#ok<SAGROW>
            qKind{end+1, 1} = char(string(getFieldOr(event, 'questionnaireKind', ''))); %#ok<SAGROW>
        end
    end

    trialResults{ti} = dst;
end

if isempty(trialResults)
    recording.trials = struct([]);
else
    recording.trials = vertcat(trialResults{:});
end

recording.questionnaire = table(qTrial, qIdentity, qTime, qContribution, qKind, ...
    'VariableNames', {'trialNumber', 'identity', 'timestamp', 'contribution', 'questionnaireKind'});

% -v7.3 supports large recordings and arrays above 2 GB.
save(outputMat, 'recording', 'raw', '-v7.3');

fprintf('Saved MAT file:\n  %s\n', outputMat);
fprintf('Trials: %d\n', recording.trialCount);
fprintf('Questionnaire responses: %d\n', height(recording.questionnaire));

%% Local helper functions
function value = getFieldOr(s, fieldName, fallback)
    if isstruct(s) && isfield(s, fieldName)
        value = s.(fieldName);
    else
        value = fallback;
    end
end

function items = asCellItems(value)
    if isempty(value)
        items = {};
    elseif iscell(value)
        items = value(:).';
    elseif isstruct(value)
        items = arrayfun(@(x) x, value(:).', 'UniformOutput', false);
    else
        items = num2cell(value(:).');
    end
end

function xy = readXY(value)
    xy = [NaN, NaN];
    if isstruct(value) && isfield(value, 'x') && isfield(value, 'y')
        xy = [numericScalar(value.x), numericScalar(value.y)];
    end
end

function value = numericScalar(value)
    if isempty(value) || ~isnumeric(value) || ~isscalar(value)
        value = NaN;
    else
        value = double(value);
    end
end
