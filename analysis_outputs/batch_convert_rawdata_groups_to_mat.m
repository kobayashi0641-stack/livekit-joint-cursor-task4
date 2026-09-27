% Batch convert RawData/g## JSON recordings to AnalyzedData/g##_data.mat.
%
% Expected folder layout:
%
%   <projectFolder>/
%       RawData/
%           g1/
%               *.json
%           g2/
%               *.json
%           ...
%       AnalyzedData/
%
% Usage:
%   1. Run this script in MATLAB.
%   2. Select <projectFolder>, the folder that contains RawData and
%      AnalyzedData.
%   3. Set groupStart/groupEnd below.
%
% Output:
%   <projectFolder>/AnalyzedData/g1_data.mat
%   <projectFolder>/AnalyzedData/g2_data.mat
%   ...
%
% Each MAT contains:
%   T               one row per frame, targetX/Y reconstructed from metadata
%   identityMap     original participant IDs mapped to test1/test2
%   samplingSummary frame interval / sampling frequency summary
%   sourceJsonPath  JSON file converted for that group
%   groupName       e.g. "g1"

clear; clc;

% Set these before running.
groupStart = 1;
groupEnd = 30;

% If a g## folder contains multiple JSON files:
%   "latest" converts the most recently modified JSON.
%   "error" stops and asks you to resolve ambiguity.
multipleJsonPolicy = "latest";

projectFolder = uigetdir(pwd, "Select folder containing RawData and AnalyzedData");
if isequal(projectFolder, 0)
    error("No folder selected.");
end

rawDataFolder = fullfile(projectFolder, "RawData");
analyzedDataFolder = fullfile(projectFolder, "AnalyzedData");

if ~isfolder(rawDataFolder)
    error("RawData folder not found: %s", rawDataFolder);
end
if ~isfolder(analyzedDataFolder)
    mkdir(analyzedDataFolder);
end

batchSummary = table();

for groupNo = groupStart:groupEnd
    groupName = "g" + string(groupNo);
    groupFolder = fullfile(rawDataFolder, groupName);

    if ~isfolder(groupFolder)
        warning("Skipping %s: folder not found.", groupName);
        continue;
    end

    jsonFiles = dir(fullfile(groupFolder, "*.json"));
    if isempty(jsonFiles)
        warning("Skipping %s: no JSON file found.", groupName);
        continue;
    end

    if numel(jsonFiles) > 1
        if multipleJsonPolicy == "error"
            error("Multiple JSON files found in %s. Set multipleJsonPolicy or clean the folder.", groupFolder);
        elseif multipleJsonPolicy == "latest"
            [~, idx] = max([jsonFiles.datenum]);
            jsonFile = jsonFiles(idx);
            warning("Multiple JSON files found in %s. Using latest: %s", groupFolder, jsonFile.name);
        else
            error("Unknown multipleJsonPolicy: %s", multipleJsonPolicy);
        end
    else
        jsonFile = jsonFiles(1);
    end

    sourceJsonPath = fullfile(jsonFile.folder, jsonFile.name);
    outMatPath = fullfile(analyzedDataFolder, groupName + "_data.mat");

    fprintf("\n[%s] Converting:\n%s\n", groupName, sourceJsonPath);

    try
        [T, identityMap, samplingSummary] = convertCursorControlJsonToTable(sourceJsonPath);
        save(outMatPath, "T", "identityMap", "samplingSummary", "sourceJsonPath", "groupName", "-v7.3");

        newRow = table( ...
            groupName, string(sourceJsonPath), string(outMatPath), height(T), ...
            samplingSummary.meanIntervalMs, samplingSummary.medianIntervalMs, ...
            samplingSummary.estimatedHzFromMean, samplingSummary.estimatedHzFromMedian, ...
            'VariableNames', {'groupName', 'sourceJsonPath', 'outMatPath', 'nRows', ...
            'meanIntervalMs', 'medianIntervalMs', 'estimatedHzFromMean', 'estimatedHzFromMedian'});
        batchSummary = [batchSummary; newRow]; %#ok<AGROW>

        fprintf("[%s] Wrote %d rows to:\n%s\n", groupName, height(T), outMatPath);
    catch ME
        warning("[%s] Failed: %s", groupName, ME.message);
    end
end

summaryPath = fullfile(analyzedDataFolder, "batch_conversion_summary.mat");
save(summaryPath, "batchSummary", "groupStart", "groupEnd", "rawDataFolder", "analyzedDataFolder");

fprintf("\nBatch conversion complete.\nSummary saved to:\n%s\n", summaryPath);

function [T, identityMap, samplingSummary] = convertCursorControlJsonToTable(jsonPath)
    data = jsondecode(fileread(jsonPath));
    trials = data.trials;

    participantIds = detectParticipantIds(trials);
    if numel(participantIds) ~= 2
        error("Expected exactly 2 participants, found %d.", numel(participantIds));
    end

    id1 = participantIds(1);
    id2 = participantIds(2);
    identityMap = table(["test1"; "test2"], [id1; id2], ...
        'VariableNames', {'OutputName', 'OriginalIdentity'});

    nRows = countFrames(trials);

    experimentName = strings(nRows, 1);
    taskType = strings(nRows, 1);
    trialNumber = nan(nRows, 1);
    phase = strings(nRows, 1);
    displayMode = strings(nRows, 1);
    trialStartTime = nan(nRows, 1);
    trialEndTime = nan(nRows, 1);
    trialDurationSec = nan(nRows, 1);
    frameNumber = nan(nRows, 1);
    timestamp = nan(nRows, 1);
    timeFromTrialStartSec = nan(nRows, 1);
    frameRateDeclared = nan(nRows, 1);

    test1_cursorX = nan(nRows, 1);
    test1_cursorY = nan(nRows, 1);
    test1_rttMs = nan(nRows, 1);
    test2_cursorX = nan(nRows, 1);
    test2_cursorY = nan(nRows, 1);
    test2_rttMs = nan(nRows, 1);

    sharedCursorX = nan(nRows, 1);
    sharedCursorY = nan(nRows, 1);
    targetX = nan(nRows, 1);
    targetY = nan(nRows, 1);
    targetSource = strings(nRows, 1);

    test1_agency = nan(nRows, 1);
    test1_partnership = nan(nRows, 1);
    test2_agency = nan(nRows, 1);
    test2_partnership = nan(nRows, 1);

    trialKey = strings(nRows, 1);
    homeHoldMs = nan(nRows, 1);
    trackingDurationMs = nan(nRows, 1);
    questionnaireRequired = nan(nRows, 1);

    row = 0;
    for ti = 1:numel(trials)
        tr = trials(ti);
        frames = tr.frames;
        meta = getStruct(tr, "trialMetadata");
        trajectory = getStruct(meta, "trajectory");

        [response1, response2] = getTrialResponses(tr, id1, id2);

        for fi = 1:numel(frames)
            fr = frames(fi);
            row = row + 1;

            experimentName(row) = getString(data, "experimentName");
            taskType(row) = getString(data, "taskType");
            trialNumber(row) = getNumber(tr, "trialNumber");
            phase(row) = getString(meta, "phase");
            displayMode(row) = getString(tr, "displayMode");
            trialStartTime(row) = getNumber(tr, "startTime");
            trialEndTime(row) = getNumber(tr, "endTime");
            trialDurationSec(row) = (trialEndTime(row) - trialStartTime(row)) / 1000;
            frameNumber(row) = getNumber(fr, "frameNumber");
            timestamp(row) = getNumber(fr, "timestamp");
            timeFromTrialStartSec(row) = (timestamp(row) - trialStartTime(row)) / 1000;
            frameRateDeclared(row) = getNumber(tr, "frameRate");

            [x1, y1, rtt1] = findCursor(fr, id1);
            [x2, y2, rtt2] = findCursor(fr, id2);
            test1_cursorX(row) = x1;
            test1_cursorY(row) = y1;
            test1_rttMs(row) = rtt1;
            test2_cursorX(row) = x2;
            test2_cursorY(row) = y2;
            test2_rttMs(row) = rtt2;

            avg = getStruct(fr, "average");
            sharedCursorX(row) = getNumber(avg, "x");
            sharedCursorY(row) = getNumber(avg, "y");

            [tx, ty] = reconstructTargetAtFrame(tr, trajectory, timestamp(row));
            targetX(row) = tx;
            targetY(row) = ty;
            targetSource(row) = "reconstructedFromMetadata";

            test1_agency(row) = getNumber(response1, "agency");
            test1_partnership(row) = getNumber(response1, "partnership");
            test2_agency(row) = getNumber(response2, "agency");
            test2_partnership(row) = getNumber(response2, "partnership");

            trialKey(row) = getString(meta, "trialKey");
            homeHoldMs(row) = getNumber(meta, "homeHoldMs");
            trackingDurationMs(row) = getNumber(meta, "trackingDurationMs");
            questionnaireRequired(row) = getNumber(meta, "questionnaireRequired");
        end
    end

    T = table( ...
        experimentName, taskType, trialNumber, phase, displayMode, ...
        trialStartTime, trialEndTime, trialDurationSec, ...
        frameNumber, timestamp, timeFromTrialStartSec, frameRateDeclared, ...
        test1_cursorX, test1_cursorY, test1_rttMs, ...
        test2_cursorX, test2_cursorY, test2_rttMs, ...
        sharedCursorX, sharedCursorY, targetX, targetY, targetSource, ...
        test1_agency, test1_partnership, test2_agency, test2_partnership, ...
        trialKey, homeHoldMs, trackingDurationMs, questionnaireRequired);

    samplingSummary = computeSamplingSummary(trials);
end

function participantIds = detectParticipantIds(trials)
    participantIds = strings(0, 1);
    for ti = 1:numel(trials)
        frames = trials(ti).frames;
        for fi = 1:numel(frames)
            if ~isfield(frames(fi), "cursors") || isempty(frames(fi).cursors)
                continue;
            end
            cursors = frames(fi).cursors;
            for ci = 1:numel(cursors)
                id = string(cursors(ci).identity);
                if strlength(id) > 0 && ~any(participantIds == id)
                    participantIds(end + 1, 1) = id; %#ok<AGROW>
                end
            end
        end
    end
    participantIds = sort(participantIds);
end

function n = countFrames(trials)
    n = 0;
    for ti = 1:numel(trials)
        n = n + numel(trials(ti).frames);
    end
end

function [response1, response2] = getTrialResponses(tr, id1, id2)
    response1 = struct();
    response2 = struct();
    if ~isfield(tr, "events") || isempty(tr.events)
        return;
    end
    for ei = 1:numel(tr.events)
        ev = tr.events(ei);
        if strcmp(getString(ev, "type"), "sharedCursorResponse")
            identity = getString(ev, "identity");
            if strcmp(identity, id1)
                response1 = ev;
            elseif strcmp(identity, id2)
                response2 = ev;
            end
        end
    end
end

function [x, y, rtt] = findCursor(frame, identity)
    x = nan;
    y = nan;
    rtt = nan;
    if ~isfield(frame, "cursors") || isempty(frame.cursors)
        return;
    end
    for ci = 1:numel(frame.cursors)
        c = frame.cursors(ci);
        if strcmp(getString(c, "identity"), identity)
            x = getNumber(c, "x");
            y = getNumber(c, "y");
            rtt = getNumber(c, "rttMs");
            return;
        end
    end
end

function [x, y] = reconstructTargetAtFrame(tr, trajectory, frameTimestamp)
    trialStart = getNumber(tr, "startTime");
    meta = getStruct(tr, "trialMetadata");
    holdMs = getNumber(trajectory, "holdMs");
    if isnan(holdMs)
        holdMs = getNumber(meta, "homeHoldMs");
    end
    if isnan(holdMs)
        holdMs = 0;
    end

    elapsedFromTrialStartMs = frameTimestamp - trialStart;
    if elapsedFromTrialStartMs < holdMs
        x = 0.5;
        y = 0.5;
        return;
    end

    t = (elapsedFromTrialStartMs - holdMs) / 1000;

    amplitudes = getVector(trajectory, "amplitudes", [0.080, 0.055, 0.045]);
    omegaX = getVector(trajectory, "omegaX", [0.90, 1.55, 2.35]);
    omegaY = getVector(trajectory, "omegaY", [0.95, 1.65, 2.20]);
    phaseX = getVector(trajectory, "phaseX", [0, pi / 2, pi]);
    phaseY = getVector(trajectory, "phaseY", [pi / 4, pi, pi / 2]);

    x = 0.5 + trajectoryAxis(t, amplitudes, omegaX, phaseX);
    y = 0.5 + trajectoryAxis(t, amplitudes, omegaY, phaseY);
end

function value = trajectoryAxis(t, amplitudes, omegas, phases)
    value = 0;
    n = min([numel(amplitudes), numel(omegas), numel(phases)]);
    for i = 1:n
        value = value + amplitudes(i) * ...
            (cos(omegas(i) * t + phases(i)) - cos(phases(i)));
    end
end

function summary = computeSamplingSummary(trials)
    allDtMs = [];
    byTrial = table();
    for ti = 1:numel(trials)
        frames = trials(ti).frames;
        ts = arrayfun(@(fr) getNumber(fr, "timestamp"), frames);
        dt = diff(ts(:));
        allDtMs = [allDtMs; dt]; %#ok<AGROW>
        trialNo = getNumber(trials(ti), "trialNumber");
        phase = getString(getStruct(trials(ti), "trialMetadata"), "phase");
        meanDt = mean(dt, "omitnan");
        medianDt = median(dt, "omitnan");
        row = table(trialNo, phase, numel(frames), meanDt, medianDt, ...
            1000 / meanDt, 1000 / medianDt, ...
            'VariableNames', {'trialNumber', 'phase', 'frameCount', ...
            'meanIntervalMs', 'medianIntervalMs', ...
            'estimatedHzFromMean', 'estimatedHzFromMedian'});
        byTrial = [byTrial; row]; %#ok<AGROW>
    end
    summary = struct();
    summary.meanIntervalMs = mean(allDtMs, "omitnan");
    summary.medianIntervalMs = median(allDtMs, "omitnan");
    summary.minIntervalMs = min(allDtMs);
    summary.maxIntervalMs = max(allDtMs);
    summary.estimatedHzFromMean = 1000 / summary.meanIntervalMs;
    summary.estimatedHzFromMedian = 1000 / summary.medianIntervalMs;
    summary.byTrial = byTrial;
end

function s = getStruct(parent, fieldName)
    if isstruct(parent) && isfield(parent, fieldName) && ~isempty(parent.(fieldName))
        s = parent.(fieldName);
    else
        s = struct();
    end
end

function v = getNumber(s, fieldName)
    v = nan;
    if ~isstruct(s) || ~isfield(s, fieldName) || isempty(s.(fieldName))
        return;
    end
    tmp = s.(fieldName);
    if islogical(tmp)
        v = double(tmp);
    elseif isnumeric(tmp)
        v = double(tmp);
    else
        parsed = str2double(string(tmp));
        if ~isnan(parsed)
            v = parsed;
        end
    end
end

function v = getString(s, fieldName)
    v = "";
    if isstruct(s) && isfield(s, fieldName) && ~isempty(s.(fieldName))
        v = string(s.(fieldName));
    end
end

function v = getVector(s, fieldName, fallback)
    if isstruct(s) && isfield(s, fieldName) && ~isempty(s.(fieldName))
        v = double(s.(fieldName));
        v = v(:)';
    else
        v = fallback;
    end
end
