function conversionSummary = convert_json2mat(groupStart, groupEnd, projectFolder)
%CONVERT_JSON2MAT Convert RawData/g# JSON recordings to AnalyzedData MAT files.
%
% Usage:
%   convert_json2mat
%       Enter the first and last group numbers in a dialog.
%
%   convert_json2mat(1, 5)
%       Convert g1 through g5 (inclusive).
%
%   convert_json2mat([1 3 5])
%       Convert only g1, g3, and g5.
%
%   convert_json2mat(1, 5, projectFolder)
%       Use an explicitly specified project folder. If omitted, the folder
%       containing this M-file is used (normally JointAgency2).
%
% Expected layout:
%   <projectFolder>/
%       convert_json2mat.m
%       RawData/
%           g1/*.json
%           g2/*.json
%           ...
%       AnalyzedData/
%
% Output:
%   <projectFolder>/AnalyzedData/g1_mat.mat
%   <projectFolder>/AnalyzedData/g2_mat.mat
%   ...
%
% MAT contents:
%   - trialData: one struct-array element per trial (same layout produced by
%     the former convert_csv2mat.m script).
%   - variableNames: fields copied into each trialData element.
%   - frameTable: the in-memory table formerly written as g##_data.csv.
%   - identityMap, samplingSummary, mergedInfo, sourceJsonPaths.
%
% Data format:
%   - One row = one recorded frame.
%   - Participant IDs are mapped to fixed output names test1/test2.
%   - test#_HandX/Y are pre-visual-disturbance hand/input positions.
%   - test#_CursorX/Y are screen cursor positions after applying visual
%     disturbance parameters from trialMetadata.cursorControl.disturbance.
%   - cursorDisturbanceType records the transform basis:
%       "gain-plus-rotation"              = gain along y=x / y=-x axes.
%       "axis-aligned-gain-plus-rotation" = gain along x=0 / y=0 axes.
%   - test#_cursorX/Y are kept as backwards-compatible aliases of
%     test#_CursorX/Y.
%   - targetX/targetY are reconstructed from trialMetadata.trajectory.
%   - test#_targetX/Y use frame.participantTargets when available, preserving
%     each participant's local start-gate timing.
%   - targetAmplitude#, targetOmegaX/Y#, targetFreqX/Y#Hz, and
%     targetPhaseX/Y# preserve the known trajectory parameters.

if nargin < 1 || isempty(groupStart)
    answer = inputdlg( ...
        {'First group number', 'Last group number'}, ...
        'JSON to MAT conversion', ...
        [1 40], ...
        {'1', '5'});
    if isempty(answer)
        error('Conversion cancelled.');
    end
    groupStart = str2double(answer{1});
    groupEnd = str2double(answer{2});
elseif nargin < 2 || isempty(groupEnd)
    groupNumbers = double(groupStart(:)');
else
    groupNumbers = double(groupStart):double(groupEnd);
end

if ~exist('groupNumbers', 'var')
    groupNumbers = double(groupStart):double(groupEnd);
end
if isempty(groupNumbers) || any(~isfinite(groupNumbers)) || ...
        any(groupNumbers < 1) || any(groupNumbers ~= fix(groupNumbers))
    error('Group numbers must be positive integers.');
end

if nargin < 3 || isempty(projectFolder)
    projectFolder = fileparts(mfilename('fullpath'));
end
projectFolder = string(projectFolder);
rawDataFolder = fullfile(projectFolder, 'RawData');
analyzedDataFolder = fullfile(projectFolder, 'AnalyzedData');

if ~isfolder(rawDataFolder)
    error('RawData folder not found: %s', rawDataFolder);
end
if ~isfolder(analyzedDataFolder)
    mkdir(analyzedDataFolder);
end

variableNames = getTrialwiseVariableNames();
conversionSummary = table();

for groupNo = groupNumbers
    groupName = "g" + string(groupNo);
    groupFolder = fullfile(rawDataFolder, groupName);

    if ~isfolder(groupFolder)
        warning('Skipping %s: folder not found: %s', groupName, groupFolder);
        continue;
    end

    jsonFiles = dir(fullfile(groupFolder, '*.json'));
    if isempty(jsonFiles)
        warning('Skipping %s: no JSON file found.', groupName);
        continue;
    end

    sourceJsonPaths = strings(numel(jsonFiles), 1);
    for ji = 1:numel(jsonFiles)
        sourceJsonPaths(ji) = string(fullfile(jsonFiles(ji).folder, jsonFiles(ji).name));
    end
    outMatPath = fullfile(analyzedDataFolder, groupName + "_mat.mat");

    fprintf("\n[%s] Converting %d JSON file(s):\n%s\n", ...
        groupName, numel(sourceJsonPaths), char(strjoin(sourceJsonPaths, newline)));

    try
        [T, identityMap, samplingSummary, mergedInfo] = ...
            convertCursorControlJsonToTable(sourceJsonPaths);
        trialData = tableToTrialData(T, variableNames);
        frameTable = T;
        save(outMatPath, "trialData", "variableNames", "frameTable", ...
            "sourceJsonPaths", "identityMap", "samplingSummary", "mergedInfo", "-v7.3");

        summaryRow = table( ...
            groupName, strjoin(sourceJsonPaths, " | "), string(outMatPath), ...
            height(T), numel(trialData), ...
            samplingSummary.meanIntervalMs, samplingSummary.medianIntervalMs, ...
            samplingSummary.estimatedHzFromMean, samplingSummary.estimatedHzFromMedian, ...
            'VariableNames', {'groupName', 'sourceJsonPath', 'outMatPath', ...
            'nRows', 'nTrials', 'meanIntervalMs', 'medianIntervalMs', ...
            'estimatedHzFromMean', 'estimatedHzFromMedian'});
        conversionSummary = [conversionSummary; summaryRow]; %#ok<AGROW>

        fprintf('[%s] Wrote %d trials (%d frames) to:\n%s\n', ...
            groupName, numel(trialData), height(T), outMatPath);
        fprintf('[%s] Converted trials: %s\n', ...
            groupName, mat2str(mergedInfo.trialNumbers(:)'));
        fprintf('[%s] Identity map:\n%s -> test1\n%s -> test2\n', ...
            groupName, identityMap.OriginalIdentity(1), identityMap.OriginalIdentity(2));
    catch ME
        warning('[%s] Conversion failed: %s', groupName, ME.message);
    end
end

fprintf('\nConversion complete. Output folder:\n%s\n', analyzedDataFolder);
if ~isempty(conversionSummary)
    disp(conversionSummary);
end
end

function variableNames = getTrialwiseVariableNames()
    variableNames = [
        "taskType"
        "phase"
        "test1_timeFromTrialStartSec"
        "test2_timeFromTrialStartSec"
        "test1_globalTimeTrialStart"
        "test2_globalTimeTrialStart"
        "test1_HandX"
        "test1_HandY"
        "test2_HandX"
        "test2_HandY"
        "test1_TargetX"
        "test1_TargetY"
        "test2_TargetX"
        "test2_TargetY"
        "sharedCursorX"
        "sharedCursorY"
        "sharedTargetX"
        "sharedTargetY"
        "targetAmplitude1"
        "targetAmplitude2"
        "targetAmplitude3"
        "targetOmegaX1"
        "targetOmegaX2"
        "targetOmegaX3"
        "targetOmegaY1"
        "targetOmegaY2"
        "targetOmegaY3"
        "targetFreqHzX1"
        "targetFreqHzX2"
        "targetFreqHzX3"
        "targetFreqHzY1"
        "targetFreqHzY2"
        "targetFreqHzY3"
        "targetPhaseX1"
        "targetPhaseX2"
        "targetPhaseX3"
        "targetPhaseY1"
        "targetPhaseY2"
        "targetPhaseY3"
        "test1_question_response"
        "test2_question_response"
    ];
end

function trialData = tableToTrialData(T, variableNames)
    requiredNames = ["trialNumber"; variableNames];
    missingNames = setdiff(requiredNames, string(T.Properties.VariableNames));
    if ~isempty(missingNames)
        error("Missing required output columns: %s", strjoin(missingNames, ", "));
    end

    trialNumbers = unique(T.trialNumber, "stable");
    scalarNames = [
        "taskType", "phase", ...
        "test1_globalTimeTrialStart", "test2_globalTimeTrialStart", ...
        "targetAmplitude1", "targetAmplitude2", "targetAmplitude3", ...
        "targetOmegaX1", "targetOmegaX2", "targetOmegaX3", ...
        "targetOmegaY1", "targetOmegaY2", "targetOmegaY3", ...
        "targetFreqHzX1", "targetFreqHzX2", "targetFreqHzX3", ...
        "targetFreqHzY1", "targetFreqHzY2", "targetFreqHzY3", ...
        "targetPhaseX1", "targetPhaseX2", "targetPhaseX3", ...
        "targetPhaseY1", "targetPhaseY2", "targetPhaseY3", ...
        "test1_question_response", "test2_question_response"
    ];
    template = struct();
    template.trialNumber = [];
    for vi = 1:numel(variableNames)
        template.(variableNames(vi)) = [];
    end
    trialData = repmat(template, numel(trialNumbers), 1);

    for ti = 1:numel(trialNumbers)
        thisTrial = trialNumbers(ti);
        idx = T.trialNumber == thisTrial;
        trialData(ti).trialNumber = thisTrial;
        for vi = 1:numel(variableNames)
            name = variableNames(vi);
            values = T.(name)(idx);
            if any(name == scalarNames)
                trialData(ti).(name) = values(1);
            else
                trialData(ti).(name) = values;
            end
        end
    end
end

function [data, mergedInfo] = loadAndMergeJsonRecordings(jsonPaths)
    jsonPaths = string(jsonPaths(:));
    nFiles = numel(jsonPaths);
    records = cell(nFiles, 1);
    experimentNames = strings(nFiles, 1);
    startTimes = nan(nFiles, 1);
    endTimes = nan(nFiles, 1);
    trialCounts = nan(nFiles, 1);

    for ji = 1:nFiles
        records{ji} = jsondecode(fileread(jsonPaths(ji)));
        experimentNames(ji) = getString(records{ji}, "experimentName");
        startTimes(ji) = getNumber(records{ji}, "startTime");
        endTimes(ji) = getNumber(records{ji}, "endTime");
        trialCounts(ji) = getNumber(records{ji}, "trialCount");
    end

    nonEmptyNames = experimentNames(strlength(experimentNames) > 0);
    if ~isempty(nonEmptyNames) && numel(unique(nonEmptyNames)) > 1
        error("Multiple experimentName values found in one group folder: %s", ...
            strjoin(unique(nonEmptyNames), ", "));
    end

    [~, order] = sort(startTimes);
    records = records(order);
    jsonPaths = jsonPaths(order);
    startTimes = startTimes(order);
    endTimes = endTimes(order);
    trialCounts = trialCounts(order);

    data = records{1};
    mergedTrials = getStruct(records{1}, "trials");
    for ji = 2:nFiles
        nextTrials = getStruct(records{ji}, "trials");
        mergedTrials = concatStructArrays(mergedTrials, nextTrials);
    end

    trialNumbers = arrayfun(@(tr) getNumber(tr, "trialNumber"), mergedTrials);
    [trialNumbers, trialOrder] = sort(trialNumbers);
    mergedTrials = mergedTrials(trialOrder);

    if numel(unique(trialNumbers)) ~= numel(trialNumbers)
        error("Duplicate trialNumber values found after merging: %s", mat2str(trialNumbers(:)'));
    end

    data.trials = mergedTrials;
    data.trialCount = numel(mergedTrials);
    data.startTime = min(startTimes);
    data.endTime = max(endTimes);

    mergedInfo = struct();
    mergedInfo.sourceJsonPaths = jsonPaths;
    mergedInfo.fileTrialCounts = trialCounts;
    mergedInfo.trialNumbers = trialNumbers;
    mergedInfo.startTimes = startTimes;
    mergedInfo.endTimes = endTimes;
end

function out = concatStructArrays(a, b)
    if isempty(a)
        out = b;
        return;
    end
    if isempty(b)
        out = a;
        return;
    end

    a = a(:);
    b = b(:);
    fields = union(string(fieldnames(a)), string(fieldnames(b)), "stable");
    a = ensureFields(a, fields);
    b = ensureFields(b, fields);
    out = [a; b];
end

function s = ensureFields(s, fields)
    for fi = 1:numel(fields)
        name = char(fields(fi));
        if ~isfield(s, name)
            [s.(name)] = deal([]);
        end
    end
    s = orderfields(s, cellstr(fields));
end

function [T, identityMap, samplingSummary, mergedInfo] = convertCursorControlJsonToTable(jsonPaths)
    [data, mergedInfo] = loadAndMergeJsonRecordings(jsonPaths);
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
    test1_timeFromTrialStartSec = nan(nRows, 1);
    test2_timeFromTrialStartSec = nan(nRows, 1);
    test1_globalTimeTrialStart = strings(nRows, 1);
    test2_globalTimeTrialStart = strings(nRows, 1);
    frameRateDeclared = nan(nRows, 1);
    cursorDisturbanceType = strings(nRows, 1);

    test1_HandX = nan(nRows, 1);
    test1_HandY = nan(nRows, 1);
    test1_CursorX = nan(nRows, 1);
    test1_CursorY = nan(nRows, 1);
    test1_GainA = nan(nRows, 1);
    test1_GainB = nan(nRows, 1);
    test1_RotationDeg = nan(nRows, 1);
    test1_cursorX = nan(nRows, 1);
    test1_cursorY = nan(nRows, 1);
    test1_rttMs = nan(nRows, 1);
    test2_HandX = nan(nRows, 1);
    test2_HandY = nan(nRows, 1);
    test2_CursorX = nan(nRows, 1);
    test2_CursorY = nan(nRows, 1);
    test2_GainA = nan(nRows, 1);
    test2_GainB = nan(nRows, 1);
    test2_RotationDeg = nan(nRows, 1);
    test2_cursorX = nan(nRows, 1);
    test2_cursorY = nan(nRows, 1);
    test2_rttMs = nan(nRows, 1);

    sharedCursorX = nan(nRows, 1);
    sharedCursorY = nan(nRows, 1);
    targetX = nan(nRows, 1);
    targetY = nan(nRows, 1);
    test1_targetX = nan(nRows, 1);
    test1_targetY = nan(nRows, 1);
    test2_targetX = nan(nRows, 1);
    test2_targetY = nan(nRows, 1);
    targetSource = strings(nRows, 1);
    targetAmplitude1 = nan(nRows, 1);
    targetAmplitude2 = nan(nRows, 1);
    targetAmplitude3 = nan(nRows, 1);
    targetOmegaX1 = nan(nRows, 1);
    targetOmegaX2 = nan(nRows, 1);
    targetOmegaX3 = nan(nRows, 1);
    targetOmegaY1 = nan(nRows, 1);
    targetOmegaY2 = nan(nRows, 1);
    targetOmegaY3 = nan(nRows, 1);
    targetFreqX1Hz = nan(nRows, 1);
    targetFreqX2Hz = nan(nRows, 1);
    targetFreqX3Hz = nan(nRows, 1);
    targetFreqY1Hz = nan(nRows, 1);
    targetFreqY2Hz = nan(nRows, 1);
    targetFreqY3Hz = nan(nRows, 1);
    targetPhaseX1 = nan(nRows, 1);
    targetPhaseX2 = nan(nRows, 1);
    targetPhaseX3 = nan(nRows, 1);
    targetPhaseY1 = nan(nRows, 1);
    targetPhaseY2 = nan(nRows, 1);
    targetPhaseY3 = nan(nRows, 1);

    test1_agency = nan(nRows, 1);
    test1_partnership = nan(nRows, 1);
    test2_agency = nan(nRows, 1);
    test2_partnership = nan(nRows, 1);
    test1_question_response = nan(nRows, 1);
    test2_question_response = nan(nRows, 1);

    trialKey = strings(nRows, 1);
    homeHoldMs = nan(nRows, 1);
    trackingDurationMs = nan(nRows, 1);
    questionnaireRequired = nan(nRows, 1);

    row = 0;
    for ti = 1:numel(trials)
        tr = trials(ti);
        frames = getStruct(tr, "frames");
        meta = getStruct(tr, "trialMetadata");
        trajectory = getStruct(meta, "trajectory");
        amplitudes = getVector(trajectory, "amplitudes", [0.080, 0.055, 0.045]);
        omegaX = getVector(trajectory, "omegaX", [0.90, 1.55, 2.35]);
        omegaY = getVector(trajectory, "omegaY", [0.95, 1.65, 2.20]);
        phaseXVec = getVector(trajectory, "phaseX", [0, pi / 2, pi]);
        phaseYVec = getVector(trajectory, "phaseY", [pi / 4, pi, pi / 2]);

        [response1, response2] = getTrialResponses(tr, id1, id2);
        participantStart1 = getParticipantTrialStart(tr, id1);
        participantStart2 = getParticipantTrialStart(tr, id2);
        participantStartText1 = epochMsToJstText(participantStart1);
        participantStartText2 = epochMsToJstText(participantStart2);
        questionResponse1 = getQuestionResponse(response1);
        questionResponse2 = getQuestionResponse(response2);

        for fi = 1:itemCount(frames)
            fr = getItem(frames, fi);
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
            test1_globalTimeTrialStart(row) = participantStartText1;
            test2_globalTimeTrialStart(row) = participantStartText2;
            test1_timeFromTrialStartSec(row) = (timestamp(row) - participantStart1) / 1000;
            test2_timeFromTrialStartSec(row) = (timestamp(row) - participantStart2) / 1000;
            frameRateDeclared(row) = getNumber(tr, "frameRate");

            [recordedX1, recordedY1, explicitHandX1, explicitHandY1, rtt1] = findCursor(fr, id1);
            [recordedX2, recordedY2, explicitHandX2, explicitHandY2, rtt2] = findCursor(fr, id2);

            [gainA1, gainB1, rotationDeg1, disturbanceType] = disturbanceParamsAtFrame(meta, 1, timeFromTrialStartSec(row));
            [gainA2, gainB2, rotationDeg2, ~] = disturbanceParamsAtFrame(meta, 2, timeFromTrialStartSec(row));
            cursorDisturbanceType(row) = disturbanceType;

            if isnan(explicitHandX1) || isnan(explicitHandY1)
                handX1 = recordedX1;
                handY1 = recordedY1;
                [cursorX1, cursorY1] = applyCursorControlDisturbance(handX1, handY1, gainA1, gainB1, rotationDeg1, disturbanceType);
            else
                handX1 = explicitHandX1;
                handY1 = explicitHandY1;
                cursorX1 = recordedX1;
                cursorY1 = recordedY1;
            end

            if isnan(explicitHandX2) || isnan(explicitHandY2)
                handX2 = recordedX2;
                handY2 = recordedY2;
                [cursorX2, cursorY2] = applyCursorControlDisturbance(handX2, handY2, gainA2, gainB2, rotationDeg2, disturbanceType);
            else
                handX2 = explicitHandX2;
                handY2 = explicitHandY2;
                cursorX2 = recordedX2;
                cursorY2 = recordedY2;
            end

            test1_HandX(row) = handX1;
            test1_HandY(row) = handY1;
            test1_CursorX(row) = cursorX1;
            test1_CursorY(row) = cursorY1;
            test1_GainA(row) = gainA1;
            test1_GainB(row) = gainB1;
            test1_RotationDeg(row) = rotationDeg1;
            test1_cursorX(row) = cursorX1;
            test1_cursorY(row) = cursorY1;
            test1_rttMs(row) = rtt1;
            test2_HandX(row) = handX2;
            test2_HandY(row) = handY2;
            test2_CursorX(row) = cursorX2;
            test2_CursorY(row) = cursorY2;
            test2_GainA(row) = gainA2;
            test2_GainB(row) = gainB2;
            test2_RotationDeg(row) = rotationDeg2;
            test2_cursorX(row) = cursorX2;
            test2_cursorY(row) = cursorY2;
            test2_rttMs(row) = rtt2;

            avg = getStruct(fr, "average");
            sharedCursorX(row) = getNumber(avg, "x");
            sharedCursorY(row) = getNumber(avg, "y");

            [tx, ty] = reconstructTargetAtFrame(tr, trajectory, timestamp(row));
            targetX(row) = tx;
            targetY(row) = ty;
            [t1x, t1y] = findParticipantTarget(fr, id1);
            [t2x, t2y] = findParticipantTarget(fr, id2);
            if isnan(t1x) || isnan(t1y)
                t1x = tx;
                t1y = ty;
            end
            if isnan(t2x) || isnan(t2y)
                t2x = tx;
                t2y = ty;
            end
            test1_targetX(row) = t1x;
            test1_targetY(row) = t1y;
            test2_targetX(row) = t2x;
            test2_targetY(row) = t2y;
            if isfield(fr, "participantTargets") && ~isempty(fr.participantTargets)
                targetSource(row) = "participantTargets";
            else
                targetSource(row) = "reconstructedFromMetadata";
            end
            targetAmplitude1(row) = vectorElement(amplitudes, 1);
            targetAmplitude2(row) = vectorElement(amplitudes, 2);
            targetAmplitude3(row) = vectorElement(amplitudes, 3);
            targetOmegaX1(row) = vectorElement(omegaX, 1);
            targetOmegaX2(row) = vectorElement(omegaX, 2);
            targetOmegaX3(row) = vectorElement(omegaX, 3);
            targetOmegaY1(row) = vectorElement(omegaY, 1);
            targetOmegaY2(row) = vectorElement(omegaY, 2);
            targetOmegaY3(row) = vectorElement(omegaY, 3);
            targetFreqX1Hz(row) = vectorElement(omegaX, 1) / (2 * pi);
            targetFreqX2Hz(row) = vectorElement(omegaX, 2) / (2 * pi);
            targetFreqX3Hz(row) = vectorElement(omegaX, 3) / (2 * pi);
            targetFreqY1Hz(row) = vectorElement(omegaY, 1) / (2 * pi);
            targetFreqY2Hz(row) = vectorElement(omegaY, 2) / (2 * pi);
            targetFreqY3Hz(row) = vectorElement(omegaY, 3) / (2 * pi);
            targetPhaseX1(row) = vectorElement(phaseXVec, 1);
            targetPhaseX2(row) = vectorElement(phaseXVec, 2);
            targetPhaseX3(row) = vectorElement(phaseXVec, 3);
            targetPhaseY1(row) = vectorElement(phaseYVec, 1);
            targetPhaseY2(row) = vectorElement(phaseYVec, 2);
            targetPhaseY3(row) = vectorElement(phaseYVec, 3);

            test1_agency(row) = getNumber(response1, "agency");
            test1_partnership(row) = getNumber(response1, "partnership");
            test2_agency(row) = getNumber(response2, "agency");
            test2_partnership(row) = getNumber(response2, "partnership");
            test1_question_response(row) = questionResponse1;
            test2_question_response(row) = questionResponse2;

            trialKey(row) = getString(meta, "trialKey");
            homeHoldMs(row) = getNumber(meta, "homeHoldMs");
            trackingDurationMs(row) = getNumber(meta, "trackingDurationMs");
            questionnaireRequired(row) = getNumber(meta, "questionnaireRequired");
        end
    end

    % Requested analysis names. Keep the original columns in frameTable for
    % traceability, while trialData contains only these concise aliases.
    test1_TargetX = test1_targetX;
    test1_TargetY = test1_targetY;
    test2_TargetX = test2_targetX;
    test2_TargetY = test2_targetY;
    sharedTargetX = targetX;
    sharedTargetY = targetY;
    targetFreqHzX1 = targetFreqX1Hz;
    targetFreqHzX2 = targetFreqX2Hz;
    targetFreqHzX3 = targetFreqX3Hz;
    targetFreqHzY1 = targetFreqY1Hz;
    targetFreqHzY2 = targetFreqY2Hz;
    targetFreqHzY3 = targetFreqY3Hz;

    T = table( ...
        experimentName, taskType, trialNumber, phase, displayMode, ...
        trialStartTime, trialEndTime, trialDurationSec, ...
        frameNumber, timestamp, timeFromTrialStartSec, ...
        test1_timeFromTrialStartSec, test2_timeFromTrialStartSec, ...
        test1_globalTimeTrialStart, test2_globalTimeTrialStart, ...
        frameRateDeclared, cursorDisturbanceType, ...
        test1_HandX, test1_HandY, test1_CursorX, test1_CursorY, ...
        test1_GainA, test1_GainB, test1_RotationDeg, ...
        test1_cursorX, test1_cursorY, test1_rttMs, ...
        test2_HandX, test2_HandY, test2_CursorX, test2_CursorY, ...
        test2_GainA, test2_GainB, test2_RotationDeg, ...
        test2_cursorX, test2_cursorY, test2_rttMs, ...
        sharedCursorX, sharedCursorY, targetX, targetY, ...
        test1_targetX, test1_targetY, test2_targetX, test2_targetY, targetSource, ...
        test1_TargetX, test1_TargetY, test2_TargetX, test2_TargetY, ...
        sharedTargetX, sharedTargetY, ...
        targetAmplitude1, targetAmplitude2, targetAmplitude3, ...
        targetOmegaX1, targetOmegaX2, targetOmegaX3, ...
        targetOmegaY1, targetOmegaY2, targetOmegaY3, ...
        targetFreqX1Hz, targetFreqX2Hz, targetFreqX3Hz, ...
        targetFreqY1Hz, targetFreqY2Hz, targetFreqY3Hz, ...
        targetFreqHzX1, targetFreqHzX2, targetFreqHzX3, ...
        targetFreqHzY1, targetFreqHzY2, targetFreqHzY3, ...
        targetPhaseX1, targetPhaseX2, targetPhaseX3, ...
        targetPhaseY1, targetPhaseY2, targetPhaseY3, ...
        test1_agency, test1_partnership, test2_agency, test2_partnership, ...
        test1_question_response, test2_question_response, ...
        trialKey, homeHoldMs, trackingDurationMs, questionnaireRequired);

    samplingSummary = computeSamplingSummary(trials);
end

function participantIds = detectParticipantIds(trials)
    participantIds = strings(0, 1);

    % First collect identities from trial events. This is more robust than
    % relying only on frames.cursors because MATLAB jsondecode can represent
    % nested arrays differently when empty arrays are mixed in.
    for ti = 1:numel(trials)
        tr = trials(ti);
        if isfield(tr, "events") && ~isempty(tr.events)
            events = tr.events;
            for ei = 1:itemCount(events)
                ev = getItem(events, ei);
                id = getString(ev, "identity");
                if strlength(id) > 0 && ~any(participantIds == id)
                    participantIds(end + 1, 1) = id; %#ok<AGROW>
                end
            end
        end
    end

    % Also scan frame cursor records. This covers files where events are
    % absent or where only cursor streams contain participant identities.
    for ti = 1:numel(trials)
        frames = getStruct(trials(ti), "frames");
        for fi = 1:itemCount(frames)
            fr = getItem(frames, fi);
            if ~isfield(fr, "cursors") || isempty(fr.cursors)
                continue;
            end
            cursors = fr.cursors;
            for ci = 1:itemCount(cursors)
                c = getItem(cursors, ci);
                id = getString(c, "identity");
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
        frames = getStruct(trials(ti), "frames");
        n = n + itemCount(frames);
    end
end

function [response1, response2] = getTrialResponses(tr, id1, id2)
    response1 = struct();
    response2 = struct();
    if ~isfield(tr, "events") || isempty(tr.events)
        return;
    end
    events = tr.events;
    for ei = 1:itemCount(events)
        ev = getItem(events, ei);
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

function startTime = getParticipantTrialStart(tr, identity)
    % Prefer the timestamp created on the participant device. It represents
    % when that participant actually passed the local start gate.
    startTime = nan;
    if ~isfield(tr, "events") || isempty(tr.events)
        return;
    end
    events = tr.events;
    for ei = 1:itemCount(events)
        ev = getItem(events, ei);
        eventType = getString(ev, "type");
        if contains(eventType, "TrackingStart") && strcmp(getString(ev, "identity"), identity)
            startTime = getNumber(ev, "participantTimestamp");
            if isnan(startTime)
                startTime = getNumber(ev, "timestamp");
            end
            return;
        end
    end
end

function textValue = epochMsToJstText(epochMs)
    if isnan(epochMs)
        textValue = missing;
        return;
    end
    dt = datetime(epochMs / 1000, ...
        'ConvertFrom', 'posixtime', ...
        'TimeZone', 'UTC');
    dt.TimeZone = 'Asia/Tokyo';
    dt.Format = 'yyyy-MM-dd-HH-mm-ss-SSS';
    textValue = string(dt);
end

function value = getQuestionResponse(response)
    % Current contribution questionnaire uses "contribution". The fallbacks
    % retain compatibility with older one-question response formats.
    value = getFirstNumber(response, ...
        ["contribution", "question_response", "response", "value", "agency"]);
end

function [x, y, handX, handY, rtt] = findCursor(frame, identity)
    x = nan;
    y = nan;
    handX = nan;
    handY = nan;
    rtt = nan;
    if ~isfield(frame, "cursors") || isempty(frame.cursors)
        return;
    end
    cursors = frame.cursors;
    for ci = 1:itemCount(cursors)
        c = getItem(cursors, ci);
        if strcmp(getString(c, "identity"), identity)
            x = getNumber(c, "x");
            y = getNumber(c, "y");
            handX = getFirstNumber(c, ["handX", "HandX", "rawX", "inputX"]);
            handY = getFirstNumber(c, ["handY", "HandY", "rawY", "inputY"]);
            rtt = getNumber(c, "rttMs");
            return;
        end
    end
end

function [x, y] = findParticipantTarget(frame, identity)
    x = nan;
    y = nan;
    if ~isfield(frame, "participantTargets") || isempty(frame.participantTargets)
        return;
    end
    targets = frame.participantTargets;
    if ~isstruct(targets)
        return;
    end
    fieldName = matlab.lang.makeValidName(char(identity));
    if isfield(targets, fieldName) && ~isempty(targets.(fieldName))
        target = targets.(fieldName);
        x = getNumber(target, "x");
        y = getNumber(target, "y");
    end
end

function [gainA, gainB, rotationDeg, disturbanceType] = disturbanceParamsAtFrame(meta, participantIndex, timeSec)
    gainA = 1;
    gainB = 1;
    rotationDeg = 0;
    disturbanceType = "none";

    cursorControl = getStruct(meta, "cursorControl");
    disturbance = getStruct(cursorControl, "disturbance");
    if isempty(fieldnames(disturbance))
        return;
    end
    disturbanceType = getString(disturbance, "type");
    if strlength(disturbanceType) == 0
        disturbanceType = "gain-plus-rotation";
    end
    if getNumber(disturbance, "enabled") ~= 1
        return;
    end

    phase = getString(cursorControl, "phase");
    if strlength(phase) == 0
        phase = getString(disturbance, "phase");
    end

    if phase == "shared"
        alpha = 1;
    else
        rampStart = getNumber(disturbance, "rampStartSeconds");
        rampDuration = getNumber(disturbance, "rampDurationSeconds");
        if isnan(rampStart)
            rampStart = 0;
        end
        if isnan(rampDuration)
            rampDuration = 0;
        end
        if isnan(timeSec) || timeSec <= rampStart
            alpha = 0;
        elseif rampDuration <= 0
            alpha = 1;
        else
            alpha = min(1, max(0, (timeSec - rampStart) / rampDuration));
        end
    end

    starts = getStruct(disturbance, "participantStart");
    ends = getStruct(disturbance, "participantEnd");
    startParams = getIndexedParams(starts, participantIndex);
    endParams = getIndexedParams(ends, participantIndex);

    gainA = lerpParam(getNumber(startParams, "gainA"), getNumber(endParams, "gainA"), alpha, 1);
    gainB = lerpParam(getNumber(startParams, "gainB"), getNumber(endParams, "gainB"), alpha, 1);
    rotationDeg = lerpParam(getNumber(startParams, "rotationDeg"), getNumber(endParams, "rotationDeg"), alpha, 0);
end

function params = getIndexedParams(values, idx)
    params = struct();
    if itemCount(values) >= idx
        params = getItem(values, idx);
    end
end

function value = lerpParam(startValue, endValue, alpha, fallback)
    if isnan(startValue)
        startValue = fallback;
    end
    if isnan(endValue)
        endValue = startValue;
    end
    value = startValue + (endValue - startValue) * alpha;
end

function [cursorX, cursorY] = applyCursorControlDisturbance(handX, handY, gainA, gainB, rotationDeg, disturbanceType)
    if isnan(handX) || isnan(handY)
        cursorX = nan;
        cursorY = nan;
        return;
    end
    if isnan(gainA)
        gainA = 1;
    end
    if isnan(gainB)
        gainB = 1;
    end
    if isnan(rotationDeg)
        rotationDeg = 0;
    end

    dx = handX - 0.5;
    dy = handY - 0.5;
    if disturbanceType == "axis-aligned-gain-plus-rotation"
        gainX = gainA * dx;
        gainY = gainB * dy;
    else
        invSqrt2 = 1 / sqrt(2);
        alongPosDiag = (dx + dy) * invSqrt2;
        alongNegDiag = (dx - dy) * invSqrt2;
        gainX = (gainA * alongPosDiag + gainB * alongNegDiag) * invSqrt2;
        gainY = (gainA * alongPosDiag - gainB * alongNegDiag) * invSqrt2;
    end
    theta = rotationDeg * pi / 180;
    cursorX = 0.5 + cos(theta) * gainX - sin(theta) * gainY;
    cursorY = 0.5 + sin(theta) * gainX + cos(theta) * gainY;
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
    for ti = 1:numel(trials)
        frames = getStruct(trials(ti), "frames");
        ts = nan(itemCount(frames), 1);
        for fi = 1:itemCount(frames)
            fr = getItem(frames, fi);
            ts(fi) = getNumber(fr, "timestamp");
        end
        allDtMs = [allDtMs; diff(ts(:))]; %#ok<AGROW>
    end
    summary = struct();
    summary.meanIntervalMs = mean(allDtMs, "omitnan");
    summary.medianIntervalMs = median(allDtMs, "omitnan");
    summary.estimatedHzFromMean = 1000 / summary.meanIntervalMs;
    summary.estimatedHzFromMedian = 1000 / summary.medianIntervalMs;
end

function s = getStruct(parent, fieldName)
    if isstruct(parent) && isfield(parent, fieldName) && ~isempty(parent.(fieldName))
        s = parent.(fieldName);
    else
        s = struct();
    end
end

function n = itemCount(value)
    if isempty(value)
        n = 0;
    else
        n = numel(value);
    end
end

function item = getItem(value, idx)
    if iscell(value)
        item = value{idx};
    else
        item = value(idx);
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

function v = getFirstNumber(s, fieldNames)
    v = nan;
    for fi = 1:numel(fieldNames)
        candidate = getNumber(s, fieldNames(fi));
        if ~isnan(candidate)
            v = candidate;
            return;
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

function v = vectorElement(values, idx)
    if numel(values) >= idx
        v = values(idx);
    else
        v = nan;
    end
end
