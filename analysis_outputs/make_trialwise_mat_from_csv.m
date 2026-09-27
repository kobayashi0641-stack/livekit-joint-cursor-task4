% Convert AnalyzedData/g##_data.csv files to trial-wise MAT files.
%
% Input CSV:
%   AnalyzedData/g1_data.csv, g2_data.csv, ...
%
% Output MAT:
%   AnalyzedData/g1_trialwise.mat, g2_trialwise.mat, ...
%
% Each MAT contains:
%   trialData       struct array, one element per trial
%   variableNames   variables extracted from the CSV
%   sourceCsvPath   source CSV file path
%
% trialData(i) fields:
%   trialNumber
%   taskType
%   phase
%   timeFromTrialStartSec
%   cursorDisturbanceType
%   test1_HandX
%   test1_HandY
%   test1_CursorX
%   test1_CursorY
%   test1_cursorX
%   test1_cursorY
%   test2_HandX
%   test2_HandY
%   test2_CursorX
%   test2_CursorY
%   test2_cursorX
%   test2_cursorY
%   sharedCursorX
%   sharedCursorY
%   targetX
%   targetY
%   test1_targetX
%   test1_targetY
%   test2_targetX
%   test2_targetY
%   targetAmplitude1-3
%   targetOmegaX1-3, targetOmegaY1-3
%   targetFreqX1Hz-3, targetFreqY1Hz-3
%   targetPhaseX1-3, targetPhaseY1-3
%   test1_agency
%   test1_partnership
%   test2_agency
%   test2_partnership

clear; clc;

% Set these before running.
groupStart = 1;
groupEnd = 30;

analyzedDataFolder = uigetdir(pwd, "Select AnalyzedData folder");
if isequal(analyzedDataFolder, 0)
    error("No folder selected.");
end

variableNames = [
    "taskType"
    "phase"
    "timeFromTrialStartSec"
    "cursorDisturbanceType"
    "test1_HandX"
    "test1_HandY"
    "test1_CursorX"
    "test1_CursorY"
    "test1_GainA"
    "test1_GainB"
    "test1_RotationDeg"
    "test1_cursorX"
    "test1_cursorY"
    "test2_HandX"
    "test2_HandY"
    "test2_CursorX"
    "test2_CursorY"
    "test2_GainA"
    "test2_GainB"
    "test2_RotationDeg"
    "test2_cursorX"
    "test2_cursorY"
    "sharedCursorX"
    "sharedCursorY"
    "targetX"
    "targetY"
    "test1_targetX"
    "test1_targetY"
    "test2_targetX"
    "test2_targetY"
    "targetAmplitude1"
    "targetAmplitude2"
    "targetAmplitude3"
    "targetOmegaX1"
    "targetOmegaX2"
    "targetOmegaX3"
    "targetOmegaY1"
    "targetOmegaY2"
    "targetOmegaY3"
    "targetFreqX1Hz"
    "targetFreqX2Hz"
    "targetFreqX3Hz"
    "targetFreqY1Hz"
    "targetFreqY2Hz"
    "targetFreqY3Hz"
    "targetPhaseX1"
    "targetPhaseX2"
    "targetPhaseX3"
    "targetPhaseY1"
    "targetPhaseY2"
    "targetPhaseY3"
    "test1_agency"
    "test1_partnership"
    "test2_agency"
    "test2_partnership"
];

for groupNo = groupStart:groupEnd
    groupName = "g" + string(groupNo);
    sourceCsvPath = fullfile(analyzedDataFolder, groupName + "_data.csv");
    outMatPath = fullfile(analyzedDataFolder, groupName + "_trialwise.mat");

    if ~isfile(sourceCsvPath)
        warning("Skipping %s: CSV not found: %s", groupName, sourceCsvPath);
        continue;
    end

    fprintf("\n[%s] Reading:\n%s\n", groupName, sourceCsvPath);
    T = readtable(sourceCsvPath);
    T = ensureDerivedCursorColumns(T);

    requiredNames = ["trialNumber"; variableNames];
    missingNames = setdiff(requiredNames, string(T.Properties.VariableNames));
    if ~isempty(missingNames)
        warning("Skipping %s: missing required columns: %s", ...
            groupName, strjoin(missingNames, ", "));
        continue;
    end

    trialNumbers = unique(T.trialNumber, "stable");
    trialData = makeEmptyTrialData(variableNames, numel(trialNumbers));

    for ti = 1:numel(trialNumbers)
        thisTrial = trialNumbers(ti);
        idx = T.trialNumber == thisTrial;
        trialData(ti).trialNumber = thisTrial;

        for vi = 1:numel(variableNames)
            name = variableNames(vi);
            trialData(ti).(name) = T.(name)(idx);
        end
    end

    save(outMatPath, "trialData", "variableNames", "sourceCsvPath");
    fprintf("[%s] Wrote %d trials to:\n%s\n", groupName, numel(trialData), outMatPath);
end

fprintf("\nTrial-wise MAT conversion complete.\n");

function trialData = makeEmptyTrialData(variableNames, nTrials)
    template = struct();
    template.trialNumber = [];
    for vi = 1:numel(variableNames)
        template.(variableNames(vi)) = [];
    end
    trialData = repmat(template, nTrials, 1);
end

function T = ensureDerivedCursorColumns(T)
    nRows = height(T);
    T = ensureStringColumn(T, "taskType", repmat("unknown", nRows, 1));
    T = ensureStringColumn(T, "phase", repmat("unknown", nRows, 1));
    T = ensureStringColumn(T, "cursorDisturbanceType", repmat("unknown", nRows, 1));

    T = ensureNumericColumnFromFallbacks(T, "test1_CursorX", ["test1_cursorX", "test1_HandX"]);
    T = ensureNumericColumnFromFallbacks(T, "test1_CursorY", ["test1_cursorY", "test1_HandY"]);
    T = ensureNumericColumnFromFallbacks(T, "test2_CursorX", ["test2_cursorX", "test2_HandX"]);
    T = ensureNumericColumnFromFallbacks(T, "test2_CursorY", ["test2_cursorY", "test2_HandY"]);
    T = ensureNumericColumnFromFallbacks(T, "test1_HandX", ["test1_CursorX", "test1_cursorX"]);
    T = ensureNumericColumnFromFallbacks(T, "test1_HandY", ["test1_CursorY", "test1_cursorY"]);
    T = ensureNumericColumnFromFallbacks(T, "test2_HandX", ["test2_CursorX", "test2_cursorX"]);
    T = ensureNumericColumnFromFallbacks(T, "test2_HandY", ["test2_CursorY", "test2_cursorY"]);

    T = ensureNumericColumn(T, "test1_GainA", ones(nRows, 1));
    T = ensureNumericColumn(T, "test1_GainB", ones(nRows, 1));
    T = ensureNumericColumn(T, "test1_RotationDeg", zeros(nRows, 1));
    T = ensureNumericColumn(T, "test2_GainA", ones(nRows, 1));
    T = ensureNumericColumn(T, "test2_GainB", ones(nRows, 1));
    T = ensureNumericColumn(T, "test2_RotationDeg", zeros(nRows, 1));

    T = ensureNumericColumnFromFallbacks(T, "test1_targetX", ["targetX"]);
    T = ensureNumericColumnFromFallbacks(T, "test1_targetY", ["targetY"]);
    T = ensureNumericColumnFromFallbacks(T, "test2_targetX", ["targetX"]);
    T = ensureNumericColumnFromFallbacks(T, "test2_targetY", ["targetY"]);

    T = ensureNumericColumn(T, "targetAmplitude1", repmat(0.080, nRows, 1));
    T = ensureNumericColumn(T, "targetAmplitude2", repmat(0.055, nRows, 1));
    T = ensureNumericColumn(T, "targetAmplitude3", repmat(0.045, nRows, 1));
    T = ensureNumericColumn(T, "targetOmegaX1", repmat(0.90, nRows, 1));
    T = ensureNumericColumn(T, "targetOmegaX2", repmat(1.55, nRows, 1));
    T = ensureNumericColumn(T, "targetOmegaX3", repmat(2.35, nRows, 1));
    T = ensureNumericColumn(T, "targetOmegaY1", repmat(0.95, nRows, 1));
    T = ensureNumericColumn(T, "targetOmegaY2", repmat(1.65, nRows, 1));
    T = ensureNumericColumn(T, "targetOmegaY3", repmat(2.20, nRows, 1));
    T = ensureNumericColumn(T, "targetFreqX1Hz", T.targetOmegaX1 / (2 * pi));
    T = ensureNumericColumn(T, "targetFreqX2Hz", T.targetOmegaX2 / (2 * pi));
    T = ensureNumericColumn(T, "targetFreqX3Hz", T.targetOmegaX3 / (2 * pi));
    T = ensureNumericColumn(T, "targetFreqY1Hz", T.targetOmegaY1 / (2 * pi));
    T = ensureNumericColumn(T, "targetFreqY2Hz", T.targetOmegaY2 / (2 * pi));
    T = ensureNumericColumn(T, "targetFreqY3Hz", T.targetOmegaY3 / (2 * pi));
    T = ensureNumericColumn(T, "targetPhaseX1", zeros(nRows, 1));
    T = ensureNumericColumn(T, "targetPhaseX2", repmat(pi / 2, nRows, 1));
    T = ensureNumericColumn(T, "targetPhaseX3", repmat(pi, nRows, 1));
    T = ensureNumericColumn(T, "targetPhaseY1", repmat(pi / 4, nRows, 1));
    T = ensureNumericColumn(T, "targetPhaseY2", repmat(pi, nRows, 1));
    T = ensureNumericColumn(T, "targetPhaseY3", repmat(pi / 2, nRows, 1));
end

function T = ensureNumericColumnFromFallbacks(T, name, fallbackNames)
    if any(strcmp(T.Properties.VariableNames, name))
        return;
    end
    value = nan(height(T), 1);
    for fi = 1:numel(fallbackNames)
        fallbackName = char(fallbackNames(fi));
        if any(strcmp(T.Properties.VariableNames, fallbackName))
            value = T.(fallbackName);
            break;
        end
    end
    T.(name) = value;
end

function T = ensureNumericColumn(T, name, value)
    if ~any(strcmp(T.Properties.VariableNames, name))
        T.(name) = value;
    end
end

function T = ensureStringColumn(T, name, value)
    if ~any(strcmp(T.Properties.VariableNames, name))
        T.(name) = value;
    end
end
