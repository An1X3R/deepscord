//go:build !windows

package main

func processCPU() (cpuMeasurement, error) {
	return cpuMeasurement{seconds: nil, status: "unsupported"}, nil
}
