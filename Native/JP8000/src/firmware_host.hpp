// Adapted from the validated local JP-8000 headless host; no transport, runtime JIT or device access.
#pragma once
// SPDX-License-Identifier: GPL-3.0-or-later
// Local headless adapter for The Usual Suspects' Gearmulator JE8086 core.
// No host audio, MIDI ports, window, hardware, or substitute synthesis.
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <limits>
#include <map>
#include <string>
#include <vector>
#include <cstdio>
#include <unistd.h>
#include "json.hpp"
#include "baseLib/logging.h"
#include "device_adapter.hpp"
#include "jeLib/je8086.h"

#include "synthLib/frontPanelSysex.h"

using Json = nlohmann::json;
using Event = synthLib::SMidiEvent;
constexpr uint32_t SampleRate = 88200;
constexpr size_t BlockSize = 128;
std::string base64(const uint8_t* data, size_t size)
{
	static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::string out;
	out.reserve((size + 2) / 3 * 4);
	for (size_t i = 0; i < size; i += 3)
	{
		uint32_t value = uint32_t(data[i]) << 16;
		if (i + 1 < size) value |= uint32_t(data[i + 1]) << 8;
		if (i + 2 < size) value |= data[i + 2];
		out.push_back(alphabet[(value >> 18) & 63]);
		out.push_back(alphabet[(value >> 12) & 63]);
		out.push_back(i + 1 < size ? alphabet[(value >> 6) & 63] : '=');
		out.push_back(i + 2 < size ? alphabet[value & 63] : '=');
	}
	return out;
}

const Json Buttons = {
	{"exit",67}, {"performance",72}, {"3",73}, {"6",74}, {"write",75},
	{"value_up",80}, {"2",81}, {"5",82}, {"8",83}, {"filter_slope",84},
	{"value_down",88}, {"1",89}, {"4",90}, {"7",91}, {"filter_type",92},
	{"upper",128}, {"key_mode",129}, {"record",130}, {"hold",131},
	{"arp_range",132}, {"arp_on",133}, {"arp_mode",134}, {"lower",136},
	{"motion2",137}, {"motion1",138}, {"osc1_wave",139}, {"lfo1_destination",140},
	{"ring",141}, {"lfo1_wave",142}, {"portamento",160}, {"octave_up",161},
	{"mono",168}, {"octave_down",169}, {"osc_sync",64}, {"osc2_wave",65}
};

// Addresses and limits from the upstream JP-8000 SysEx parameter model (jemiditypes.h).
const Json Parameters = {
	{"cutoff",{{"index",41},{"max",127},{"label","Filter cutoff"}}},
	{"resonance",{{"index",42},{"max",127},{"label","Resonance"}}},
	{"osc1_waveform",{{"index",30},{"max",6},{"label","Oscillator 1 waveform"}}},
	{"osc1_control1",{{"index",31},{"max",127},{"label","Oscillator 1 control 1"}}},
	{"osc1_control2",{{"index",32},{"max",127},{"label","Oscillator 1 control 2"}}},
	{"osc_balance",{{"index",23},{"max",127},{"label","Oscillator balance"}}},
	{"attack",{{"index",54},{"max",127},{"label","Amp attack"}}},
	{"decay",{{"index",55},{"max",127},{"label","Amp decay"}}},
	{"sustain",{{"index",56},{"max",127},{"label","Amp sustain"}}},
	{"release",{{"index",57},{"max",127},{"label","Amp release"}}},
	{"chorus",{{"index",62},{"max",127},{"label","Chorus level"}}},
	{"delay",{{"index",66},{"max",127},{"label","Delay level"}}}
};

int checkedInt(const Json& value, int low, int high, const char* label)
{
	if (!value.is_number_integer()) throw std::runtime_error(std::string(label) + " must be an integer");
	const auto result = value.get<int64_t>();
	if (result < low || result > high) throw std::runtime_error(std::string(label) + " out of range");
	return static_cast<int>(result);
}

std::vector<Event> parseMidi(const Json& input, size_t frames)
{
	if (!input.is_array() || input.size() > 512) throw std::runtime_error("midi must be an array of at most 512 events");
	std::vector<Event> out;
	for (const auto& item : input)
	{
		const auto& bytes = item.is_object() ? item.at("bytes") : item;
		if (!bytes.is_array() || bytes.empty() || bytes.size() > 4096) throw std::runtime_error("invalid MIDI bytes");
		Event event(synthLib::MidiEventSource::Host);
		event.offset = item.is_object() ? checkedInt(item.value("offset", Json(0)), 0, int(frames - 1), "offset") : 0;
		std::vector<uint8_t> data;
		for (const auto& byte : bytes) data.push_back(uint8_t(checkedInt(byte, 0, 255, "MIDI byte")));
		if (data[0] == 0xf0)
		{
			if (data.size() < 2 || data.back() != 0xf7) throw std::runtime_error("unterminated SysEx");
			for (size_t i = 1; i + 1 < data.size(); ++i) if (data[i] > 127) throw std::runtime_error("invalid SysEx data");
			event.sysex.assign(data.begin(), data.end());
		}
		else
		{
			const uint8_t status = data[0];
			if (status < 0x80 || status > 0xef) throw std::runtime_error("only channel MIDI or complete SysEx accepted");
			const size_t expected = (status & 0xe0) == 0xc0 ? 2 : 3;
			if (data.size() != expected) throw std::runtime_error("incorrect MIDI event length");
			for (size_t i = 1; i < data.size(); ++i) if (data[i] > 127) throw std::runtime_error("invalid MIDI data");
			event.a = status; event.b = data[1]; event.c = expected == 3 ? data[2] : 0;
		}
		out.push_back(std::move(event));
	}
	std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.offset < b.offset; });
	return out;
}

class Host
{
public:
	explicit Host(const NativeCreateParams& params,const std::vector<uint8_t>& ram) : device(params,ram)
	{
		jeLib::Rom rom(params.romData, params.romName);
		rom.getPresets(presets);
		// Unity conversion preserves the emulated DAC word: signed 24-bit / 8388608.
		// The upstream test console's 7x and device default's 12x are post-DSP host gain, not firmware.
		device.setMasterVolume(1.0f);
		panel.evLcdText.addListener([this](uint32_t cols, uint32_t rows, const std::vector<uint8_t>& cells)
		{
			lcdCells = cells;
			lcd = Json::array();
			for (size_t row = 0; row < rows; ++row)
			{
				std::string line;
				for (size_t col = 0; col < std::min<uint32_t>(cols, 16); ++col)
				{
					const auto index = row * cols + col;
					const auto c = index < cells.size() ? cells[index] : uint8_t(' ');
					line.push_back(c >= 32 && c < 127 ? char(c) : ' ');
				}
				lcd.push_back(line);
			}
		});
		panel.evLcdCgRam.addListener([this](const auto& value) { cgRam.assign(value.begin(), value.end()); });
		std::vector<Event> request;
		synthLib::fp::sendRequestState(request);
		process(128, request, false);
		startupFrames += 128;
		// Advance only emulated time; no clock sleeps or host audio. The firmware is the boot authority.
		while (startupFrames < SampleRate * 20ull)
		{
			process(2048, {}, false);
			startupFrames += 2048;
			if (startupFrames >= SampleRate && lcd.dump().find("PERFORM") != std::string::npos) break;
		}
		booted = lcd.dump().find("PERFORM") != std::string::npos;
		if (!booted) throw std::runtime_error("firmware did not reach PERFORM LCD within 20 emulated seconds");
		Event systemRequest(synthLib::MidiEventSource::Editor), performanceRequest(synthLib::MidiEventSource::Editor);
		systemRequest.sysex = jeLib::State::createSystemRequest();
		performanceRequest.sysex = jeLib::State::createPerformanceRequest(jeLib::AddressArea::PerformanceTemp, jeLib::UserPerformanceArea::UserPerformance01);
		process(SampleRate, {systemRequest, performanceRequest}, false);
		startupFrames += SampleRate;
		for (size_t i = 0; i < 8 * SampleRate / 2048 && !stateComplete(); ++i)
		{
			process(2048, {}, false);
			startupFrames += 2048;
		}
		if (!stateComplete()) throw std::runtime_error("firmware state dump incomplete after startup requests");
		framePosition = 0;
	}

	Json status() const
	{
		return {{"ok",true},{"model","jp8000"},{"backend","Gearmulator JE8086"},{"booted",booted},
			{"sample_rate",SampleRate},{"channels",2},{"format","f32le"},{"frame_position",framePosition},
			{"startup_frames",startupFrames},{"board_cycles",device.getJe8086().cycles()},
			{"output_gain",1.0},{"output_conversion","signed 24-bit DAC / 8388608; no normalization or clipping"},
			{"lcd",lcd},{"lcd_cells",lcdCells},{"lcd_cgram",cgRam},{"buttons",Buttons},{"parameters",Parameters},
			{"parameter_values",parameterValues()},
			{"state_syncing",refreshInFlight || nextRefreshFrame != NoRefresh},{"state_sync_error",refreshError},
			{"capabilities",{{"audio",true},{"display",true},{"panel",true},{"state",true},{"load_state",true},{"panic",true},{"presets",true},{"parameters",true}}}};
	}

	Json command(const Json& input)
	{
		const auto op = input.at("op").get<std::string>();
		if (op == "status") return status();
		if (op == "presets")
		{
			Json list = Json::array();
			for (size_t bank = 0; bank < std::min<size_t>(presets.size(),2); ++bank)
				for (size_t index = 0; index < presets[bank].size(); ++index)
				{
					const auto& preset = presets[bank][index];
					if (!preset.empty()) list.push_back({{"index",bank * 64 + index},{"name",jeLib::State::getName(preset.front()).value_or("")}});
				}
			return {{"ok",true},{"presets",list}};
		}
		if (op == "preset" || op == "parameter")
		{
			if (pending.size() >= 500) throw std::runtime_error("pending queue full; render to advance firmware");
			const auto part = input.value("part", std::string("upper"));
			if (part != "upper" && part != "lower") throw std::runtime_error("part must be upper or lower");
			const auto destination = part == "lower" ? jeLib::PerformanceData::PatchLower : jeLib::PerformanceData::PatchUpper;
			if (op == "parameter")
			{
				const auto name = input.at("name").get<std::string>();
				const auto& definition = Parameters.at(name);
				const auto value = checkedInt(input.at("value"), 0, definition.at("max"), "parameter value");
				Event event(synthLib::MidiEventSource::Editor);
				event.sysex = jeLib::State::createParameterChange(destination, static_cast<jeLib::Patch>(definition.at("index").get<int>()), value);
				pending.push_back(std::move(event));
			}
			else
			{
				const auto index = checkedInt(input.at("index"), 0, 127, "preset index");
				for (const auto& message : presets.at(index / 64).at(index % 64))
				{
					Event event(synthLib::MidiEventSource::Editor); event.sysex = message;
					jeLib::State::setAddress(event.sysex, static_cast<uint32_t>(jeLib::AddressArea::PerformanceTemp) | static_cast<uint32_t>(destination));
					jeLib::State::updateChecksum(event.sysex);
					pending.push_back(std::move(event));
				}
			}
			return {{"ok",true},{"queued",true},{"applied",false},{"frame_position",framePosition}};
		}
		if (op == "render")
		{
			const size_t frames = checkedInt(input.at("frames"), 1, 8192, "frames");
			auto events = parseMidi(input.value("midi", Json::array()), frames);
			if (refreshInFlight && framePosition > refreshSentAt + SampleRate * 5ull)
			{
				refreshInFlight = false;
				refreshError = "firmware patch refresh timed out";
			}
			if (!refreshInFlight && nextRefreshFrame < framePosition + frames)
			{
				Event system(synthLib::MidiEventSource::Editor), performance(synthLib::MidiEventSource::Editor);
				system.sysex = jeLib::State::createSystemRequest();
				performance.sysex = jeLib::State::createPerformanceRequest(jeLib::AddressArea::PerformanceTemp, jeLib::UserPerformanceArea::UserPerformance01);
				system.offset = performance.offset = uint32_t(nextRefreshFrame > framePosition ? nextRefreshFrame - framePosition : 0);
				events.push_back(std::move(system)); events.push_back(std::move(performance));
				refreshInFlight = true; refreshAreas.fill(false); refreshSentAt = framePosition;
				refreshError.clear(); nextRefreshFrame = NoRefresh;
			}
			std::vector<Event> later;
			for (auto event : pending)
			{
				if (event.offset < frames) events.push_back(std::move(event));
				else { event.offset -= uint32_t(frames); later.push_back(std::move(event)); }
			}
			pending = std::move(later);
			std::stable_sort(events.begin(), events.end(), [](const auto& a, const auto& b) { return a.offset < b.offset; });
			const auto start = std::chrono::steady_clock::now();
			auto pcm = process(frames, events, true);
			if(input.value("_native",false)){lastPcm=std::move(pcm);return Json::object();}
			double peak = 0, energy = 0;
			for (float value : pcm)
			{
				if (!std::isfinite(value)) throw std::runtime_error("nonfinite firmware audio");
				peak = std::max(peak, std::abs(double(value))); energy += double(value) * value;
			}
			auto reply = status();
			reply["frames"] = frames;
			reply["pcm_b64"] = base64(reinterpret_cast<const uint8_t*>(pcm.data()), pcm.size() * sizeof(float));
			reply["peak"] = peak; reply["rms"] = std::sqrt(energy / pcm.size());
			reply["render_ms"] = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now() - start).count();
			return reply;
		}
		if (op == "panel")
		{
			const auto button = input.at("button");
			int id = button.is_string() ? Buttons.at(button.get<std::string>()).get<int>() : checkedInt(button, 0, 255, "button");
			bool valid = false;
			for (const auto& item : Buttons.items()) if (item.value() == id) valid = true;
			if (!valid) throw std::runtime_error("unknown panel button");
			if (pending.size() >= 512) throw std::runtime_error("pending panel queue full; render to advance firmware");
			const bool down = input.at("down").get<bool>();
			uint32_t offset = 0;
			if (down) buttonDownFrame[id] = framePosition;
			else if (const auto it = buttonDownFrame.find(id); it != buttonDownFrame.end())
			{
				// A browser tap may enqueue both edges before the next audio block. Let the firmware scanner see 50 ms down.
				const uint64_t releaseFrame = it->second + SampleRate / 20;
				offset = uint32_t(releaseFrame > framePosition ? releaseFrame - framePosition : 0);
				buttonDownFrame.erase(it);
			}
			synthLib::fp::sendButton(pending, uint32_t(id), down);
			pending.back().offset = offset;
			// Physical panel changes are not echoed as patch dumps. Ask the original firmware after its scanner settles.
			nextRefreshFrame = framePosition + offset + SampleRate / 10;
			return {{"ok",true},{"queued",true},{"applied",false},{"button",id},{"frame_position",framePosition}};
		}
		if (op == "state")
		{
			std::vector<uint8_t> bytes;
			const bool valid = device.getState(bytes, 0) && stateComplete();
			return {{"ok",valid},{"complete",valid},{"format","roland-sysex-and-host-parameters"},{"bytes",bytes},{"frame_position",framePosition},{"pending_events",pending.size()},
				{"state_syncing",refreshInFlight || nextRefreshFrame != NoRefresh},{"state_sync_error",refreshError}};
		}
		if (op == "load_state")
		{
			const auto& values = input.at("bytes");
			if (!values.is_array() || values.empty() || values.size() > 65536) throw std::runtime_error("invalid state bytes");
			std::vector<uint8_t> bytes;
			for (const auto& value : values) bytes.push_back(uint8_t(checkedInt(value, 0, 255, "state byte")));
			if (!completeStateBytes(bytes)) throw std::runtime_error("state requires complete system, performance, parts and patches");
			std::vector<Event> messages;
			for (size_t start = 0; start < bytes.size();)
			{
				const auto end = std::find(bytes.begin() + start, bytes.end(), uint8_t(0xf7));
				if (bytes[start] != 0xf0 || end == bytes.end()) throw std::runtime_error("invalid state framing");
				Event event(synthLib::MidiEventSource::Host);
				event.sysex.assign(bytes.begin() + start, end + 1);
				for (size_t i = 1; i + 1 < event.sysex.size(); ++i)
					if (event.sysex[i] > 127) throw std::runtime_error("invalid state data");
				if (event.sysex[1] == 0x41)
				{
					uint32_t sum = 0;
					for (size_t i = 6; i + 1 < event.sysex.size(); ++i) sum += event.sysex[i];
					if (sum % 128) throw std::runtime_error("invalid Roland state checksum");
				}
				else if (event.sysex.size() != 19 || event.sysex[1] != 0x7d)
					throw std::runtime_error("unknown state message");
				// Host level preferences are not machine state; keep this transport's explicit unity gain.
				if (event.sysex[1] == 0x41) messages.push_back(std::move(event));
				start = size_t(end - bytes.begin()) + 1;
			}
			if (pending.size() + messages.size() > 512) throw std::runtime_error("pending queue full; render to advance firmware");
			pending.insert(pending.end(), messages.begin(), messages.end());
			return {{"ok",true},{"queued",true},{"applied",false},{"frame_position",framePosition}};
		}
		if (op == "panic")
		{
			if (pending.size() > 464) throw std::runtime_error("pending queue full; render to advance firmware");
			for (int channel = 0; channel < 16; ++channel)
				for (int cc : {64,120,123})
				{
					Event e(synthLib::MidiEventSource::Host); e.a = uint8_t(0xb0 + channel); e.b = uint8_t(cc); e.c = 0; pending.push_back(e);
				}
			return {{"ok",true},{"queued",true}};
		}
		throw std::runtime_error("unknown op");
	}

public:
	Json parameterValues() const
	{
		Json values = {{"upper",Json::object()},{"lower",Json::object()}};
		std::vector<uint8_t> state;
		if (!device.getState(state, 0)) return values;
		for (size_t start = 0; start < state.size();)
		{
			const auto end = std::find(state.begin() + start, state.end(), uint8_t(0xf7));
			if (end == state.end()) break;
			const size_t size = size_t(end - state.begin()) - start + 1;
			if (size >= 252 && state[start+1] == 0x41 && state[start+6] == 1 && state[start+7] == 0 &&
				(state[start+8] == 0x40 || state[start+8] == 0x42) && state[start+9] == 0)
			{
				const auto part = state[start+8] == 0x40 ? "upper" : "lower";
				for (const auto& parameter : Parameters.items())
					values[part][parameter.key()] = state[start + 10 + parameter.value().at("index").get<size_t>()];
			}
			start += size;
		}
		return values;
	}
	bool stateComplete()
	{
		std::vector<uint8_t> data;
		if (!device.getState(data, 0)) return false;
		return completeStateBytes(data);
	}
	static bool completeStateBytes(const std::vector<uint8_t>& data)
	{
		// The library accepts partial dumps. Require all six firmware areas before advertising a complete patch state.
		const std::array<std::pair<uint32_t,size_t>,6> required = {{{0,35},{0x01000000,48},{0x01001000,19},
			{0x01001100,19},{0x01004000,252},{0x01004200,252}}};
		std::array<bool,6> found{};
		for (size_t start = 0; start < data.size();)
		{
			auto end = std::find(data.begin() + start, data.end(), uint8_t(0xf7));
			if (end == data.end()) break;
			const size_t size = size_t(end - data.begin()) - start + 1;
			if (size >= 12 && data[start] == 0xf0 && data[start+1] == 0x41 && data[start+5] == 0x12)
			{
				uint32_t address = 0;
				for (size_t n = 6; n < 10; ++n) address = (address << 8) | data[start+n];
				for (size_t n = 0; n < required.size(); ++n)
					if (address == required[n].first && size >= required[n].second) found[n] = true;
			}
			start += size;
		}
		return std::all_of(found.begin(), found.end(), [](bool value) { return value; });
	}
	std::vector<float> process(size_t frames, const std::vector<Event>& events, bool count)
	{
		std::vector<float> pcm;
		pcm.reserve(frames * 2);
		std::array<float,BlockSize> left{}, right{};
		synthLib::TAudioInputs inputs{};
		synthLib::TAudioOutputs outputs{}; outputs[0] = left.data(); outputs[1] = right.data();
		for (size_t offset = 0; offset < frames; offset += BlockSize)
		{
			const size_t n = std::min(BlockSize, frames - offset);
			std::vector<Event> incoming, outgoing;
			for (auto event : events)
				if (event.offset >= offset && event.offset < offset + n) { event.offset -= uint32_t(offset); incoming.push_back(std::move(event)); }
			device.process(inputs, outputs, n, incoming, outgoing);
			for (const auto& event : outgoing) if (!event.sysex.empty())
			{
				panel.receive(event.sysex);
				if (refreshInFlight)
				{
					const auto address = jeLib::State::getAddress(event.sysex);
					const std::array<std::pair<uint32_t,size_t>,6> required = {{{0,35},{0x01000000,48},{0x01001000,19},
						{0x01001100,19},{0x01004000,252},{0x01004200,252}}};
					for (size_t i = 0; i < required.size(); ++i)
						if (address == required[i].first && event.sysex.size() >= required[i].second) refreshAreas[i] = true;
					if (std::all_of(refreshAreas.begin(),refreshAreas.end(),[](bool v){return v;})) refreshInFlight = false;
				}
			}
			for (size_t i = 0; i < n; ++i) { pcm.push_back(left[i]); pcm.push_back(right[i]); }
		}
		if (count) framePosition += frames;
		return pcm;
	}
	mutable jeLib::NativeDevice device;
	synthLib::FrontPanelTransport panel;
	Json lcd = Json::array({"", ""});
	std::vector<uint8_t> lcdCells, cgRam;
	std::vector<Event> pending;
	std::map<int,uint64_t> buttonDownFrame;
	std::vector<std::vector<jeLib::Rom::Preset>> presets;
	uint64_t framePosition = 0, startupFrames = 0;
	static constexpr uint64_t NoRefresh = std::numeric_limits<uint64_t>::max();
	uint64_t nextRefreshFrame = NoRefresh, refreshSentAt = 0;
	std::array<bool,6> refreshAreas{};
	bool refreshInFlight = false;
	std::string refreshError;
	bool booted = false;
 std::vector<float> lastPcm;
};
