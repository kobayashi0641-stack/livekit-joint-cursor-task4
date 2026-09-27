% Convert shared-single-cursor-control JSON to one combined CSV.
%
% - One row = one recorded frame.
% - Participant identities are renamed to test1 and test2 in the output.
% - Target X/Y are always reconstructed from trialMetadata.trajectory,
%   because recorded target time series can be incomplete or static.

clear; clc;

jsonPath = "C:\Users\owner\Downloads\2026-05-26T07-56-17_shared-single-cursor-control_N2_2026-05-26T07-55-31_21-trials.json";
outCsvPath = "C:\Users\owner\Desktop\liveKit-proj-toshiki\analysis_outputs\shared_single_cursor_21_trials_test1_test2_matlab.csv";

raw = fileread(jsonPath);
data = jsondecode(raw);

trials = data.trials;

% Detect original participant identities from cursor records.
participantIds = strings(0, 1);
for ti = 1:numel(trials)
    frames = trials(ti).frames;
    for fi = 1:numel(frames)
        if isfield(frames(fi), "cursors")
            cursors = frames(fi).cursors;
            for ci = 1:numel(cursors)
                id = string(cursors(ci).identity);
                if ~any(participantIds == id)
                    participantIds(end + 1, 1) = id; %#ok<SAGROW>
                end
            end
        end
    end
end
participantIds = sort(participantIds);

if numel(participantIds) ~= 2
    error("Expected exactly 2 participants, found %d.", numel(participantIds));
end

id1 = participantIds(1);
id2 = participantIds(2);

% Preallocate generously by counting frames.
nRows = 0;
for ti = 1:numel(trials)
    nRows = nRows + numel(trials(ti).frames);
end

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

test1_agency = nan(nRows, 1);
test1_partnership = nan(nRows, 1);
test2_agency = nan(nRows, 1);
test2_partnership = nan(nRows, 1);

trialKey = strings(nRows, 1);
homeHoldMs = nan(nRows, 1);
trackingDurationMs = nan(nRows, 1);
questionnaireRequired = false(nRows, 1);

row = 0;

for ti = 1:numel(trials)
    tr = trials(ti);
    frames = tr.frames;
    meta = tr.trialMetadata;
    traj = meta.trajectory;

    response1 = struct();
    response2 = struct();
    if isfield(tr, "events")
        for ei = 1:numel(tr.events)
            ev = tr.events(ei);
            if isfield(ev, "type") && strcmp(string(ev.type), "sharedCursorResponse") && isfield(ev, "identity")
                if strcmp(string(ev.identity), id1)
                    response1 = ev;
                elseif strcmp(string(ev.identity), id2)
                    response2 = ev;
                end
            end
        end
    end

    for fi = 1:numel(frames)
        fr = frames(fi);
        row = row + 1;

        experimentName(row) = string(data.experimentName);
        taskType(row) = string(data.taskType);
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

        [c1x, c1y, c1rtt] = findCursor(fr, id1);
        [c2x, c2y, c2rtt] = findCursor(fr, id2);
        test1_cursorX(row) = c1x;
        test1_cursorY(row) = c1y;
        test1_rttMs(row) = c1rtt;
        test2_cursorX(row) = c2x;
        test2_cursorY(row) = c2y;
        test2_rttMs(row) = c2rtt;

        if isfield(fr, "average") && ~isempty(fr.average)
            sharedCursorX(row) = getNumber(fr.average, "x");
            sharedCursorY(row) = getNumber(fr.average, "y");
        end

        % Always reconstruct target from parameters instead of using
        % frames.target or frames.participantTargets.
        [tx, ty] = reconstructTargetAtFrame(tr, traj, timestamp(row));
        targetX(row) = tx;
        targetY(row) = ty;

        if isfield(response1, "agency")
            test1_agency(row) = getNumber(response1, "agency");
            test1_partnership(row) = getNumber(response1, "partnership");
        end
        if isfield(response2, "agency")
            test2_agency(row) = getNumber(response2, "agency");
            test2_partnership(row) = getNumber(response2, "partnership");
        end

        trialKey(row) = getString(meta, "trialKey");
        homeHoldMs(row) = getNumber(meta, "homeHoldMs");
        trackingDurationMs(row) = getNumber(meta, "trackingDurationMs");
        questionnaireRequired(row) = logical(getNumber(meta, "questionnaireRequired"));
    end
end

T = table( ...
    experimentName, taskType, trialNumber, phase, displayMode, ...
    trialStartTime, trialEndTime, trialDurationSec, ...
    frameNumber, timestamp, timeFromTrialStartSec, frameRateDeclared, ...
    test1_cursorX, test1_cursorY, test1_rttMs, ...
    test2_cursorX, test2_cursorY, test2_rttMs, ...
    sharedCursorX, sharedCursorY, targetX, targetY, ...
    test1_agency, test1_partnership, test2_agency, test2_partnership, ...
    trialKey, homeHoldMs, trackingDurationMs, questionnaireRequired);

writetable(T, outCsvPath);

fprintf("Wrote %d rows to:\n%s\n", height(T), outCsvPath);
fprintf("Original identities: %s -> test1, %s -> test2\n", id1, id2);

% Estimate sampling frequency from frame timestamps.
allDtMs = [];
for ti = 1:numel(trials)
    ts = arrayfun(@(fr) getNumber(fr, "timestamp"), trials(ti).frames);
    allDtMs = [allDtMs; diff(ts(:))]; %#ok<AGROW>
end
fprintf("Median frame interval: %.3f ms (%.3f Hz)\n", median(allDtMs, "omitnan"), 1000 / median(allDtMs, "omitnan"));
fprintf("Mean frame interval: %.3f ms (%.3f Hz)\n", mean(allDtMs, "omitnan"), 1000 / mean(allDtMs, "omitnan"));

function [x, y, rtt] = findCursor(frame, identity)
    x = nan;
    y = nan;
    rtt = nan;
    if ~isfield(frame, "cursors") || isempty(frame.cursors)
        return;
    end
    for i = 1:numel(frame.cursors)
        c = frame.cursors(i);
        if isfield(c, "identity") && strcmp(string(c.identity), identity)
            x = getNumber(c, "x");
            y = getNumber(c, "y");
            rtt = getNumber(c, "rttMs");
            return;
        end
    end
end

function [x, y] = reconstructTargetAtFrame(trial, trajectory, frameTimestamp)
    trialStart = getNumber(trial, "startTime");
    holdMs = getNumber(trajectory, "holdMs");
    if isnan(holdMs)
        holdMs = getNumber(trial.trialMetadata, "homeHoldMs");
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

function out = trajectoryAxis(t, amplitudes, omegas, phases)
    out = 0;
    for i = 1:numel(amplitudes)
        out = out + amplitudes(i) * (cos(omegas(i) * t + phases(i)) - cos(phases(i)));
    end
end

function v = getNumber(s, fieldName)
    v = nan;
    if isfield(s, fieldName) && ~isempty(s.(fieldName))
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
end

function v = getString(s, fieldName)
    v = "";
    if isfield(s, fieldName) && ~isempty(s.(fieldName))
        v = string(s.(fieldName));
    end
end

function v = getVector(s, fieldName, fallback)
    if isfield(s, fieldName) && ~isempty(s.(fieldName))
        v = double(s.(fieldName));
        v = v(:)';
    else
        v = fallback;
    end
end
